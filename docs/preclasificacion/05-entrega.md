# Preclasificación — entrega de la fase 1: la captura

Fecha: 2026-11-11. Rama: `feature/preclasificacion`. Aprobada por JP en la sesión.

**Esta entrega es solo la fase 1.** Las fases 2 a 9 del diseño (el interruptor, los
criterios, la conversación, la clasificación) **no se implementaron**: siguen
esperando los criterios médicos de los cirujanos.

**No se desplegó nada.** El Worker en producción sigue corriendo `6c581a7`.

---

## 1. Qué hace esta fase

Que lo que la paciente contesta a una pregunta clínica **se guarde, aunque la
conversación no llegue a un asesor.**

Hasta hoy se guardaba en el 81% de las conversaciones que escalan y en el 23% de las
que no — 306 pacientes en un mes que contestaron y cuyo dato se tiró. La causa era un
atajo de ahorro: desde el tercer mensaje, con el procedimiento ya claro, no se volvía
a llamar al clasificador, y el tamizaje ocurre en el turno cinco u ocho.

---

## 2. Un bug que apareció al verificar, y era peor que el problema

Verificando el cambio contra datos reales apareció que **la cuarta expresión de
`PREGUNTAS_DEL_TAMIZAJE` no reconocía la tercera pregunta del tamizaje.**

Pedía `proceso activo de (pérdida|aumento) de peso`, y la forma en que Sofía la hace
—la que el propio prompt le da como ejemplo— es:

> "¿Está en un proceso activo de **pérdida o aumento** de peso?"

Ahí "pérdida" no va seguido de "de peso", así que no calzaba. Medido sobre 36.661
mensajes de Sofía de 30 días:

| expresión | mensajes que reconocía |
|---|---|
| está embarazada | 1.470 |
| planes de… | 1.462 |
| lactancia | 1.334 |
| **peso** | **106**, de 1.072 reales — **se perdía el 90%** |

**Consecuencia que ya estaba viva en producción:** la tercera cola, desplegada el 10 de
noviembre, usa esa misma lista para detectar que Sofía dejó una pregunta colgando. O
sea que **la cola no veía a las pacientes que se quedaban calladas después de la
pregunta del peso.** El agujero que esa cola vino a cerrar seguía abierto por un
tercio.

Se corrigió en el mismo commit porque la fase 1 depende de esa misma lista.

---

## 3. Qué se modificó

Un solo archivo: `src/index.js`. Tres cambios.

| # | dónde | qué |
|---|---|---|
| 1 | `PREGUNTAS_DEL_TAMIZAJE` | la expresión del peso, corregida (sección 2) |
| 2 | `veniaDeUnaPreguntaClinica()` (nueva) | ¿el último mensaje de Sofía traía una pregunta del tamizaje? |
| 3 | `getConversationState()` | lee además `tamizaje_embarazo`, `tamizaje_lactancia`, `tamizaje_peso` |
| 4 | `yaClasificada` en `processInboundMessage()` | la excepción al atajo |

### 3.1 La excepción, en una frase

No se saltea la clasificación cuando se cumplen **las dos** cosas: falta algún dato del
tamizaje, **y** el mensaje anterior de Sofía traía una de esas preguntas.

### 3.2 Por qué `veniaDeUnaPreguntaClinica()` y no `preguntoElTamizaje()`

La función que ya existía exige que el mensaje **termine** en pregunta, porque ahí lo
que importa es qué fue lo último que la paciente leyó y la dejó esperando. Acá importa
otra cosa —si hay una respuesta que capturar— y eso pasa igual cuando Sofía preguntó a
mitad del mensaje y después siguió explicando.

### 3.3 Dos condiciones, no tres

El diseño (4.1) proponía tres condiciones: zona del tamizaje, dato faltante, y pregunta
previa. **Se implementaron dos: la zona se dejó afuera.** Si Sofía hizo una de esas
preguntas, ya está en una zona del tamizaje; y si la hizo donde no debía —medido: 26
casos en tratamientos no quirúrgicos— conviene que el dato quede guardado igual. Una
expresión regular de zonas acá solo habría agregado otra forma de perder el dato en
silencio, que es justo el bug de la sección 2.

### 3.4 Por qué esto no puede perder datos

`upsertConversation()` arrastra el valor guardado cuando el clasificador devuelve
`null` (`t.embarazo ?? existing[0]?.tamizaje_embarazo ?? null`). El tamizaje es
pegajoso. Así que **reclasificar solo puede agregar datos, nunca borrarlos.** Es la
propiedad que hace seguro este cambio.

### 3.5 Observabilidad

Cada vez que la excepción se dispara queda una línea `SOFIA_RECLASIFICA_TAMIZAJE` con
el `prospectId` y el `messageCount`. Sirve para contar el gasto real y para comprobar
que funciona.

---

## 4. Pruebas

El arnés con mocks del diseño (4.10) **no se construyó**: es para el flujo de la
preclasificación, que no se implementó. Para un cambio de esta forma —una condición
sobre datos que ya existen— la verificación que vale es contra las conversaciones
reales, y es la que se hizo.

### 4.1 Compilación

`npx wrangler deploy --dry-run` pasa: 188,40 KiB, 49,64 KiB comprimido. (`node --check`
no sirve en este repo: pasa siempre.)

### 4.2 La condición, simulada sobre 30 días reales

Se recorrieron las 8.420 conversaciones con actividad entre el 2026-10-11 y el
2026-11-11, turno por turno, aplicando la condición nueva:

| | resultado |
|---|---|
| clasificaciones extra, techo | **3.049 al mes → ~$4,0** |
| conversaciones que toca | 1.281 |
| conversaciones sin escalar con tamizaje incompleto | 485 |
| **a las que la condición llega** | **365 (75%)** |

El techo ignora la segunda condición (que falte un dato), así que el gasto real es
menor. Coincide con los $4 estimados en el diseño.

**El 25% al que no llega** se revisó caso por caso: son conversaciones donde la
paciente **nunca contestó** después de la pregunta (140 de 201). No hay nada que
capturar ahí y es el comportamiento correcto; esas pacientes las agarra la tercera
cola, que a partir de este commit sí ve la pregunta del peso.

### 4.3 La expresión corregida, contra falsos positivos

Reconoce 1.085 mensajes contra 106 de la anterior. De los nuevos, los que no son
preguntas son mensajes donde Sofía **resume** el tema del peso ("ya me confirmó que no
está en un proceso de pérdida o aumento de peso"). Para la excepción de la fase 1 eso
significa una clasificación de más —barata, y no puede perder datos— y para la tercera
cola no cuenta, porque esa sí exige que el mensaje termine en pregunta.

Casos probados a mano:

| texto | reconoce |
|---|---|
| "¿Está en un proceso activo de pérdida o aumento de peso?" | sí (antes **no**) |
| "¿está actualmente en un proceso de pérdida o aumento de peso?" | sí |
| "¿Está en un proceso activo de aumento de peso?" | sí |
| "¿tiene un cambio de peso activo?" | sí |
| "su peso debe estar estable antes de operarse" | no (correcto: no es pregunta) |

### 4.4 Lo que no se puede probar sintéticamente

Que la captura suba del 23%. Eso es una medición, no una prueba: se repite el cruce de
la sección 2.3 del diseño **dos semanas después del despliegue** y se compara. Las
redes de respaldo no se prueban simulando.

---

## 5. Lo que no se alteró

- **El prompt**: no se tocó ni una línea de `sofia_config.system_prompt`. La regla del
  tamizaje, la prohibición de conducta, el orden de la conversación, los precios y la
  sección de screening están exactamente como estaban.
- **Las etiquetas**: `[ESCALAR]`, `[NO_RESPONDER]`, `[CERRAR]` y `[PROGRAMAR]` intactas.
- **Las integraciones**: Zenvia, Meta, Supabase, Cloudflare, Anthropic, OpenAI. Ninguna
  credencial, variable de entorno ni webhook.
- **La base de datos**: ninguna migración, ninguna columna nueva. Esta fase usa columnas
  que ya existen. El SQL de `03-propuesta-sql.md` sigue sin ejecutarse.
- **Dependencias**: ninguna nueva. `package.json` sin cambios.
- **El round-robin, la nota de Zenvia, el tope de turnos, la atención nocturna, el
  seguimiento proactivo y el dedup**: sin cambios.
- **El atajo de ahorro**: sigue existiendo. Solo tiene una excepción acotada; en los
  turnos sin respuesta clínica que capturar se saltea igual que antes.

---

## 6. Riesgos pendientes

| riesgo | qué tan silencioso | qué lo contiene |
|---|---|---|
| El gasto es mayor que los $4 estimados | visible en la factura, con retraso | contar las líneas `SOFIA_RECLASIFICA_TAMIZAJE` a la semana; el prompt acota solo, porque repite una pregunta una vez y no una tercera |
| **La expresión corregida cambia el comportamiento de la tercera cola** | medio: se va a ver como más traspasos | es el comportamiento que esa cola debía tener desde el 10 de noviembre; hay que mirar el volumen los primeros días |
| La reclasificación cambia `sentiment` en turnos donde antes quedaba congelado | bajo, y es una mejora | el score de Seguimiento usa `sentiment`, así que algunos puestos de la cola se van a mover |
| Un error del clasificador en un turno tardío tira el `catch` y pierde el turno | medio, hay `console.error` | el tamizaje pegajoso: lo guardado no se pierde |

**Y una limitación que hay que decir con claridad: esta fase no tiene interruptor.** No
es el flujo de la preclasificación —es un arreglo del clasificador— y darle un
interruptor habría pedido una columna nueva. Si hay que volver atrás, es revertir el
commit y desplegar (sección 8). Lo que lo hace aceptable es que el modo de falla es el
gasto, no el comportamiento: este cambio no puede perder datos ni cambiar lo que Sofía
le dice a una paciente.

---

## 7. Criterios médicos que siguen pendientes

Todos. Esta fase no usa ninguno. Lo que falta está en la sección 7 del diseño: la lista
de procedimientos, los criterios por procedimiento, las preguntas, si alguno necesita
un número, el texto del protocolo de urgencia y la razón que se le da a la paciente.

---

## 8. Cómo revertir

```bash
# en cec-sofia-whatsapp
git revert <hash del commit>
npx wrangler deploy
```

No hay SQL que revertir (no se corrió ninguno) ni prompt que restaurar (no se tocó).

Si lo único que hay que frenar es Sofía entera, el interruptor de emergencia sigue
siendo `sofia_config.whatsapp_enabled = false`, que no necesita desplegar nada.

---

## 9. Evidencia

El commit de esta fase es **`55c9ac2`**. Está en GitHub, comprobado contra el remoto
de verdad y no contra la copia local de la referencia:

```
$ git ls-remote origin feature/preclasificacion
55c9ac2d7112b2ea08c7c3d1a92e5921da71ae59  refs/heads/feature/preclasificacion

$ git log --oneline origin/feature/preclasificacion -4
55c9ac2 fix(captura): el tamizaje se perdía cuando la conversación no escalaba…
32586f6 docs(preclasificación): la propuesta en ejemplos, no solo el diagnóstico
658d656 docs(preclasificación): diseño de la v1, y el embudo pierde el 42%…
97e0ecc docs(preclasificación): la marca de la tercera cola se queda pegada
```

**Y lo que NO está hecho, dicho con la misma claridad: no se desplegó.** El Worker en
producción sigue corriendo `6c581a7`, que es `main`. Este repo no despliega desde git:
hasta que alguien corra `npx wrangler deploy`, nada de esto está atendiendo a ninguna
paciente. Tampoco hay merge a `main`.
