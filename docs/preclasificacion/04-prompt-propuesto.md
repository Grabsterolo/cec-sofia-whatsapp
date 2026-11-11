# Preclasificación — texto propuesto para el system prompt

Fecha: 2026-11-11. **`sofia_config.system_prompt` no se tocó.** Esto es el texto
propuesto, el diff contra el prompt vivo y la explicación de cada regla, para que lo
aplique JP.

El prompt vivo de referencia: 59.973 caracteres, 382 líneas, leído de `sofia_config`
el 2026-11-11. El diseño que justifica cada regla está en
[`02-diseno-v1.md`](02-diseno-v1.md).

---

## 1. Un solo punto de inserción

El bloque entra **después** del último párrafo de la sección de screening (el que
empieza con *"Tampoco traslades la recomendación de esperar a un tratamiento no
quirúrgico"*, línea 324) y **antes** de `# Longitud de respuesta en WhatsApp`
(línea 326).

Ahí, por tres razones: queda pegado a la sección cuyas zonas comparte, no parte
ninguna sección existente, y deja la regla de longitud —que es la que gobierna cuántas
preguntas caben en un mensaje— inmediatamente después.

**Ninguna línea existente se borra ni se reescribe.** El diff es una inserción pura.

---

## 2. Dos frenos, no uno

El bloque se desactiva solo, y además el código no lo alimenta. Los dos frenos son a
propósito: el primero es una instrucción y un modelo puede aplicarla mal; el segundo
es código y no se equivoca.

1. **El bloque se autodesactiva.** Su primer párrafo dice que la sección entera no
   existe si más abajo no aparece un bloque `CRITERIOS APROBADOS`. Con la lista de
   procedimientos vacía ese bloque no llega nunca, así que el texto queda inerte.
2. **El código no inyecta los criterios** si `preclasificacion_enabled` es `false`, si
   `preclasificacion_procedimientos` está vacío, o si `preclasificacion_criterios`
   está vacío.

El costo de dejar el texto siempre en el prompt es unos 450 tokens dentro del bloque
que ya se cachea: no agrega un bloque de caché nuevo y no toca el techo de cuatro.

---

## 3. El texto propuesto

```
# Orientación clínica antes de coordinar — solo con criterios aprobados

Esta sección entera depende de que más abajo, en este mismo mensaje de sistema, aparezca un bloque titulado CRITERIOS APROBADOS. Si ese bloque no aparece, esta sección no existe: no hagas ninguna de las preguntas de las que habla, no menciones ninguna revisión médica y coordina la valoración como lo harías sin ella. No deduzcas los criterios de otra parte de la BASE DE CONOCIMIENTO ni de conocimiento médico general: si no están escritos en ese bloque, no hay criterios y no hay nada que evaluar.

Cuándo aplica: solo si el procedimiento del que están hablando aparece nombrado en el bloque CRITERIOS APROBADOS, Y además la sección de preguntas de screening aplica a esa cirugía. Si falla cualquiera de las dos, esta sección no aplica — y todo lo que esa otra sección prohíbe sigue prohibido exactamente igual, incluida la prohibición de preguntar por embarazo, lactancia o cambio de peso de ninguna forma.

CUÁNDO PREGUNTAS
Las preguntas de esta sección se hacen en el mismo momento que las de screening: cuando la paciente ya mostró intención concreta de agendar. Mientras se está informando, no. Que pregunte el precio no es intención de agendar.

EL PERMISO VA ANTES DEL TEMA
La primera vez que vayas a entrar en terreno clínico, pide permiso en una frase y espera la respuesta antes de preguntar nada. Si dice que no, el tema se cierra ahí: no lo vuelvas a abrir en esa conversación, sigue conversando con normalidad y coordina la valoración igual. Un "no" no cambia nada de lo que sigue, y no se comenta.

CÓMO PREGUNTAS
Una pregunta por mensaje, siempre. Antes de cada una, en la misma frase, di para qué sirve ese dato. Y en cada una, dile con naturalidad que si prefiere no decirlo no hay ningún problema: es una opción real, no una fórmula de cortesía.
Antes de preguntar algo, revisa si la conversación ya lo contestó. Si ya lo dijo, esa pregunta está contestada y no se hace.
Si no contesta, se repite una sola vez al final del mensaje siguiente. No hay una tercera vez.
Si se incomoda, se molesta o te pide que no sigas, paras ahí. No hay segunda ronda y lo que falte se anota en el motivo del traspaso.
Como máximo tres preguntas de esta sección, además de las de screening. Solo las que estén pedidas en el bloque CRITERIOS APROBADOS, y en el orden en que estén escritas ahí. No agregues preguntas tuyas, por razonables que te parezcan.

NUNCA PIDES UNA CIFRA DEL CUERPO
No preguntas el peso, la estatura, la talla, ni el índice de masa corporal, ni "cuántos kilos". Tampoco reformulado, ni como dato administrativo, ni para "dejarle el caso armado al equipo", ni presentándolo como consulta al equipo médico. La única excepción es que el bloque CRITERIOS APROBADOS pida ese número explícitamente; si no lo pide, no se pide.
Lo que sí haces, y es distinto, es preguntar por su historia: desde cuándo lo nota, si apareció después de algo —un embarazo, una baja de peso, una cirugía previa—. Esas no son preguntas clínicas y las sigues haciendo como hasta ahora, porque son las que de verdad te dejan entender su caso.

SI DA UNA CIFRA POR SU CUENTA
Se guarda y no se comenta. No la repitas, no la interpretes, no le menciones nunca un índice de masa corporal, no le digas que su peso es un problema y no le pongas el peso como condición para operarse. Si lo que dijo tiene que ver con una recomendación de la BASE DE CONOCIMIENTO, se aplica esa recomendación tal cual está escrita y nada más.

SI PIDE HABLAR CON UNA PERSONA
Pasas el caso en ese mismo mensaje, en cualquier etapa, con [ESCALAR: motivo]. No terminas la ronda de preguntas primero.

QUÉ HACES CON EL RESULTADO
Si nada de los criterios se activa y no falta ningún dato: coordinas la valoración como siempre.
Si algo se activa, falta un dato, o ella prefirió no contestar: le dices con calidez que su caso lo revisa el equipo médico antes de la cita, sin adelantar ningún resultado y sin nombrarle qué fue lo que llamó la atención. Y pasas el caso.
Nunca le dices que no es candidata, que no cumple, que probablemente el médico va a decir que no, ni ninguna versión suave de eso. Eso no lo dices tú: lo dice una persona del equipo, después de revisar su caso.
Una negativa a dar un dato nunca cuenta en contra: ese caso va a revisión del equipo médico, nunca a "no es candidata".

EL MOTIVO DEL TRASPASO
Empieza por lo que ella pidió —agendar la valoración de la cirugía concreta— y después, en palabras, qué tiene que revisar el equipo y qué quedó sin confirmar. Sin prefijos, sin códigos y sin inventarle a la paciente un dato que no dio. Lo lee alguien que no vio la conversación.

SEÑALES DE ALARMA
PENDIENTE_APROBACION_MEDICA — texto del protocolo de urgencia: qué se le dice a una paciente con señales de alarma o una posible complicación, y a dónde va el caso. Mientras esto no esté aprobado, estos casos siguen el camino que ya existe en la sección "Qué no puedes responder": se pasan de inmediato con [ESCALAR: motivo], sin proceso comercial y sin coordinar ninguna valoración.
```

Y el bloque que el código concatena al final, cuando hay criterios cargados:

```
CRITERIOS APROBADOS
<contenido de sofia_config.preclasificacion_criterios, que empieza por su versión y
fecha — por ejemplo "CRITERIOS v1 — 2026-11-20" — y nombra, por procedimiento, qué
preguntar y qué hace que un caso necesite revisión médica>
```

---

## 4. El diff contra el prompt vivo

Inserción pura entre la línea 324 y la 326. Nada se borra.

```diff
  Nunca uses [PROGRAMAR] junto con [CERRAR], y nunca lo uses donde esta sección no aplica: ahí estas tres preguntas no se hacen y no hay nada que programar.

  Tampoco traslades la recomendación de esperar a un tratamiento no quirúrgico. El embarazo, la lactancia o un cambio de peso no posponen Ultherapy, Morpheus8, Liftera, toxina botulínica, Radiesse, ácido hialurónico ni ningún otro tratamiento de la sección 5. […]
+
+# Orientación clínica antes de coordinar — solo con criterios aprobados
+
+[el texto completo de la sección 3]

  # Longitud de respuesta en WhatsApp
  MÁXIMO 4 líneas por mensaje y UN SOLO MENSAJE por cada mensaje del paciente. […]
```

---

## 5. De dónde sale cada regla

| regla del bloque | de dónde sale |
|---|---|
| El bloque se autodesactiva sin `CRITERIOS APROBADOS` | conflicto 6.10 de la auditoría: la lista vacía apagaba la clasificación pero no la conversación |
| "No deduzcas los criterios de otra parte ni de conocimiento médico general" | la regla de JP de no inventar criterios médicos, dicha de forma que el modelo no la pueda rodear |
| Solo dentro de las zonas de screening | decisión 2 de JP; así la prohibición de conducta del prompt vivo no se reescribe |
| Mismo momento que el screening, y el precio no cuenta | ya es la regla vigente; se repite para que el bloque no abra una puerta nueva |
| **El permiso va antes del tema** | paso *Ask* de las 5A de manejo de obesidad: se pide permiso para hablar del tema, y si dice que no, no se insiste |
| **Cada pregunta dice para qué sirve** | revisión de co-diseño de autoevaluación por chatbot: los participantes querían cada pregunta de salud justificada |
| **Cada pregunta ofrece no contestar** | de la misma revisión: la opción de saltar la pregunta tiene que ofrecerse, no solo aceptarse |
| Una por mensaje | ya es la regla, y ahora hay un número: el 15,7% de los tamizajes la rompe y ahí se pierde el 48% de las respuestas |
| No repreguntar lo ya dicho | ya es la regla; se puso porque Sofía le preguntó por embarazo a 98 señoras que ya habían dicho su edad |
| Una repetición y no una tercera | ya es la regla del screening |
| Paras si se incomoda | caso 7 de las pruebas, y principio de autonomía |
| Máximo tres, y solo las de los criterios | alcance del planteo (2.3.5), con el añadido de que no las elige Sofía |
| **Nunca pides una cifra del cuerpo** | 3.4 y 3.6 del diseño: no se pide un dato que no cambie lo que pasa después, y hoy ningún criterio aprobado usa un número. Y porque medido, solo el 0,4% de las conversaciones trae peso y estatura: pedirlo tendría todo el costo y casi ningún rendimiento |
| La lista de las formas prohibidas de pedirlo | la prohibición de conducta del prompt vivo ya enseñó que la regla abstracta no frena la frase: hay que nombrar la reformulación |
| Preguntar por la historia sí | medido: Sofía ya lo hace en el 29% de las conversaciones y la paciente contesta con sustancia en el 69% |
| Si da la cifra, no se comenta | literatura de estigma de peso: atribuirle a la paciente su cuerpo o poner el peso como condición daña la relación y hace que evite la consulta |
| Pide una persona → se pasa de inmediato | alcance del planteo (2.3.8) y guías de diseño de chatbots de salud: ofrecer el paso a una persona cuando hay duda o tema sensible |
| Nunca le dices que no es candidata | estado C del planteo (2.4): en la v1 la noticia la da una persona |
| La negativa no cuenta en contra | alcance del planteo (2.3.7) |
| El motivo empieza por lo que ella pidió | decisión 3 de JP: sin prefijo, y con las palabras que el dashboard ya puntúa y agrupa |
| Señales de alarma pendientes de aprobación | regla de JP: donde falte un criterio, va `PENDIENTE_APROBACION_MEDICA` |

---

## 6. Los choques con instrucciones existentes

Ninguna instrucción vigente se borra. Estos son los roces y cómo se resuelven.

### 6.1 La prohibición de conducta del screening

El prompt vivo prohíbe preguntar por embarazo, lactancia o cambio de peso "de NINGUNA
forma" donde la sección de screening no aplica, incluso reformulado.

**No hay choque**, por la decisión 2 de JP: el bloque nuevo vive dentro de las mismas
zonas. Y el propio bloque lo repite en su segundo párrafo, para que no se lea como una
puerta nueva. Si en el futuro alguien quiere llevar el flujo a otras cirugías, **esa
prohibición hay que reescribirla primero, y se puso por un caso medido.**

### 6.2 La regla de longitud: 4 líneas y un mensaje por mensaje

Pedir permiso, decir para qué sirve el dato, ofrecer no contestar y preguntar **no
caben con naturalidad en cuatro líneas**. Es el roce más real de los tres.

Cómo se resuelve sin tocar la regla: el permiso es **un turno propio y corto**, y
recién en los turnos siguientes van las preguntas, cada una con su porqué en la misma
frase. Por eso el tope efectivo sube (4.6 del diseño): el permiso también ocupa un
turno.

### 6.3 "Nunca prometas averiguar algo y confirmarlo después"

Decirle "su caso lo revisa el equipo médico antes de la cita" se parece a una promesa
de contacto, y hay una red de código que escala cuando detecta esas frases
(`:1779`). **Acá eso es lo correcto**: el caso tiene que escalar. Lo que hay que
revisar en la implementación es que no se escale **dos veces** y que el motivo que
quede sea el de la preclasificación y no `frase de traspaso detectada sin etiqueta
[ESCALAR]`.

### 6.4 La red del precio diferido

`difiereAlEquipo()` (`:2368`) escala con el motivo `difirió el precio al equipo sin
etiqueta [ESCALAR]` cuando Sofía difiere un dato al equipo. "Eso lo revisa el equipo
médico" puede caer ahí y dejar un motivo falso. Hay que revisar esa lista de frases
contra el texto nuevo; está anotado como fase 7 del diseño y como caso de prueba 19.

---

## 7. Lo que se propone quitar, y es decisión de JP

Esto **no está incluido** en el diff de arriba porque toca texto existente.

El prompt vivo, en la sección de screening, le entrega a Sofía la frase hecha:

> Ejemplo de la primera, nombrando SIEMPRE la cirugía concreta […]: "Antes de coordinar
> su valoración para [la cirugía] **necesito confirmarle un par de cosas rápidas**, para
> asegurarnos de que sea el mejor momento. ¿Está embarazada o tiene planes de estarlo
> en los próximos dos años?"

Y cuatro párrafos antes, en la prohibición de conducta, prohíbe esa misma frase:

> Tampoco si la reformulas (**"necesito confirmarle un par de cosas rápidas"**, "un dato
> más antes de coordinar")…

**Medido el 2026-11-11: la frase aparece en 1.162 mensajes de los últimos 30 días.** Es
la muletilla con la que el tamizaje se siente como un formulario, y la paciente la
recibe justo después de haber pedido una cita.

Lo que se propone: **dejar el ejemplo pero sacarle la frase**, o sea mostrar la
estructura (nombrar la cirugía concreta + una pregunta) sin entregar el texto literal.
La parte que de verdad hace falta en ese ejemplo es "nombra el procedimiento", y eso se
puede decir sin regalarle una frase para copiar.

Por qué se deja a decisión de JP y no se incluye: cambia una instrucción vigente, y lo
que pase después hay que medirlo. No se puede comprobar con una prueba sintética — se
ve leyendo conversaciones una semana después.

---

## 8. Cómo se aplica y cómo se revierte

**Aplicar**, en este orden:

1. Guardar un respaldo en `sofia_config_backups` **con el motivo escrito** ("antes del
   bloque de orientación clínica, 2026-11-xx"). Es la única vuelta atrás que existe:
   `sofia_config` no guarda historial y `updated_at` no se toca cuando el script sube
   el prompt.
2. Pegar el bloque de la sección 3 en el punto de la sección 1, desde el dashboard.
3. Verificar que el prompt vivo quedó con el bloque y que **nada más cambió**:
   comparar el largo antes y después contra los 59.973 caracteres de hoy más el bloque.
4. **No cargar todavía** `preclasificacion_procedimientos` ni
   `preclasificacion_criterios`. Con eso vacío, el bloque queda inerte y se puede
   confirmar en producción que Sofía no cambió de comportamiento.
5. Probar con conversaciones reales leídas al día siguiente, no con "Probar a Sofía":
   esa pantalla usa el prompt que tiene el navegador en memoria, y una respuesta
   idéntica entre iteraciones significa que el cambio no llegó.

**Revertir:** restaurar `system_prompt` desde el respaldo del paso 1. Es inmediato y
no necesita desplegar nada. Si lo único que hay que frenar es el flujo, alcanza con
vaciar `preclasificacion_procedimientos` o apagar `preclasificacion_enabled`, que no
toca el prompt.

**Y anotar el cambio** en el registro de `docs/Sofia-Base-de-Conocimiento.md`, en el
mismo turno, como manda el CLAUDE.md del dashboard.
