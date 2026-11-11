# Arreglo propuesto: "bajé de peso" no es "estoy bajando de peso"

Fecha: 2026-11-11. **`sofia_config.system_prompt` no se tocó.** Esto es el texto
propuesto y su diff, para que lo aplique JP desde el dashboard.

Lo encontró JP probando como paciente: Sofía le recomendó esperar a tener el peso
estable **sin conocer su peso y sin haberle preguntado nada del tamizaje**, solo porque
él contestó "cambio de peso" a una pregunta sobre la **causa** de su flacidez
abdominal.

---

## 1. Qué pasa, y cuánto

El prompt manda comunicar la recomendación de esperar *"SIEMPRE que el tema surja…
si un paciente menciona en cualquier momento de la conversación que está embarazada,
en lactancia, o cambiando de peso **activamente**"*. Sofía se salta el "activamente":
trata el pasado como presente.

Medido sobre las 8.420 conversaciones con actividad entre el 2026-10-11 y el
2026-11-11:

| | |
|---|---|
| conversaciones donde Sofía recomendó esperar por peso | **280** |
| de esas, **sin haber preguntado nunca** el tamizaje del peso | **53 (19%)** |
| de esas 53, terminaron **programadas** (aparcadas con fecha) | **23** |
| de esas 23, claramente mal al leerlas una por una | **~11** |

Las cuatro peores, con el texto real de la paciente:

| lo que dijo | hasta cuándo quedó aparcada |
|---|---|
| "Suspendí la lactancia hace 10 meses" | **2027-10** |
| "Tengo mucha flacidez y los pechos caídos **porque bajé de peso**" | 2027-07 |
| "Tengo 3 cesáreas y la última fue hace 8 años 7 meses" | 2027-02 |
| "¿Cuánto cuesta eso?" | 2027-02 |

**Cuatro de las once ni siquiera hablaban de peso**: contestaban la pregunta de
lactancia o de embarazo, o preguntaban el precio.

**Por qué duele.** La paciente que bajó 20 o 30 kilos es la candidata ideal de una
abdominoplastia o una mastopexia: el exceso de piel es justo lo que esas cirugías
resuelven. El error cae sistemáticamente sobre las mejores pacientes, y en vez de
pasarlas a un asesor las guarda hasta un año. Son unas 11 por mes.

---

## 2. Dónde entra

Inserción pura **después** del párrafo que empieza *"Recomendación de nuestros
especialistas, que debes comunicar SIEMPRE que el tema surja…"* (línea 306 del prompt
vivo) y **antes** de *"Si el paciente responde afirmativamente a cualquiera de las
tres al momento de agendar…"* (línea 308).

Ahí, porque es el párrafo que produce el error y el de después es el que decide el
`[PROGRAMAR]`. El bloque nuevo queda entre los dos: acota el primero antes de que
llegue al segundo.

**Ninguna línea existente se borra ni se reescribe.**

---

## 3. El texto propuesto

```
PASADO Y PRESENTE NO SON LO MISMO, Y CONFUNDIRLOS LE CUESTA MESES A LA PACIENTE

Esa recomendación aplica a una situación que está ocurriendo AHORA. No aplica a algo que la paciente cuenta como la causa de lo que quiere corregir.

"Bajé 20 kilos el año pasado", "esto me quedó después de adelgazar", "los senos se me cayeron porque bajé de peso" son el MOTIVO DE CONSULTA, no un proceso activo. Esa paciente no tiene que esperar nada: es exactamente la candidata del procedimiento, porque el exceso de piel que le molesta es el que la cirugía retira. No le menciones la recomendación de esperar, no la programes, y sigue coordinando con normalidad.

"Estoy bajando de peso", "estoy en dieta", "me faltan diez kilos", "voy a empezar un tratamiento para bajar" sí son un proceso activo, y ahí la recomendación aplica.

Si lo que dijo no deja claro si eso ya terminó o si todavía sigue, no lo asumas en ninguna de las dos direcciones: pregúntale si ese proceso ya terminó o si continúa, y espera su respuesta antes de decir nada sobre esperar. Preguntar de más cuesta un mensaje; asumir mal le cuesta a ella meses de espera que no necesitaba.

La recomendación se da por lo que la paciente dijo sobre ESA situación, no sobre otra. Si lo que contestó era sobre lactancia, sobre embarazos, sobre cesáreas o sobre su edad, eso no habilita la recomendación del peso, ni ninguna otra. Y una situación que ya terminó —lactancia suspendida hace más de seis meses, un embarazo de hace años, una cesárea vieja— no se trata como vigente: queda resuelta, se lo decís así y se sigue adelante.

[PROGRAMAR] va solo cuando la paciente confirmó que la situación está vigente y te dijo cuándo termina. Nunca por una deducción tuya a partir de algo que contó de pasada. Si no lo confirmó, no hay nada que programar.
```

---

## 4. El diff

```diff
  Recomendación de nuestros especialistas, que debes comunicar SIEMPRE que el tema surja mientras se habla de una cirugía (no solo al agendar): lo ideal es esperar a no encontrarse en ninguna de estas tres situaciones antes de operarse […]
+
+PASADO Y PRESENTE NO SON LO MISMO, Y CONFUNDIRLOS LE CUESTA MESES A LA PACIENTE
+
+[el texto completo de la sección 3]

  Si el paciente responde afirmativamente a cualquiera de las tres al momento de agendar, no sigas coordinando el agendamiento. […]
```

---

## 5. Por qué cada parte

| parte | por qué |
|---|---|
| "aplica a una situación que está ocurriendo AHORA" | es lo que el párrafo de arriba ya dice con la palabra "activamente", y que se pierde. Se dice otra vez, sola y en su propio párrafo |
| Los ejemplos en pasado | son frases **reales** de las pacientes medidas, no inventadas. Una regla abstracta no frena la conducta: hay que nombrar la frase concreta que la dispara |
| "es exactamente la candidata del procedimiento" | le da la razón clínica, no solo la prohibición. Sin el porqué, la regla se erosiona en los casos raros |
| Los ejemplos en presente | para que la corrección no produzca el error opuesto: dejar de programar a quien sí tiene que esperar |
| "pregúntale si ya terminó o si continúa" | la salida correcta ante la duda es preguntar, no asumir. Y cuesta un mensaje |
| "por lo que dijo sobre ESA situación, no sobre otra" | cubre los cuatro casos que ni siquiera hablaban de peso. Es la misma regla de atribución que el tamizaje ya tiene para no poner `false` en las tres cuando contestó "no" a una sola |
| "una situación que ya terminó queda resuelta" | el caso de la lactancia suspendida hace 10 meses, aparcada hasta octubre de 2027 |
| "[PROGRAMAR] solo cuando confirmó" | es el candado: aunque Sofía se equivoque al hablar, no aparca a nadie sin una confirmación |

---

## 6. Lo que NO cambia

- El tamizaje: las tres preguntas, cuándo se hacen, de una en una, y qué pasa si
  contesta que sí. Igual que hoy.
- La recomendación de esperar cuando la paciente **sí** está en un proceso activo.
- `[PROGRAMAR]`, su formato, sus tres motivos y el cálculo de la fecha.
- Las zonas donde el tamizaje aplica, y la prohibición de conducta fuera de ellas.
- Los precios, los procedimientos y cualquier regla institucional.

---

## 7. Una consecuencia para el diseño de la preclasificación

La pregunta por la historia que propone [`02-diseno-v1.md`](02-diseno-v1.md) —"¿desde
cuándo lo nota?, ¿apareció después de algo?"— **es exactamente el disparador de esos
53 casos**. Volverla regla sin este arreglo multiplica el error en vez de reducirlo.

Y la señal `cambio_peso` del clasificador (sección 4.4 del diseño) tiene que
partirse en dos, por la misma razón: `cambio_peso_pasado` (un dato clínico útil, y
muchas veces el motivo de consulta) y `proceso_de_peso_activo` (el único que puede
frenar una cirugía). Una sola categoría para las dos cosas mete la misma confusión en
la base.

**Este arreglo es requisito de la fase 3 del diseño, no un trabajo paralelo.**

---

## 8. Cómo aplicarlo y cómo revertirlo

**Aplicar:**

1. Guardar un respaldo en `sofia_config_backups` con el motivo escrito ("antes del
   bloque de pasado/presente del peso, 2026-11-xx"). Es la única vuelta atrás:
   `sofia_config` no guarda historial y `updated_at` no se toca cuando el script sube
   el prompt.
2. Pegar el bloque de la sección 3 en el punto de la sección 2, desde el dashboard.
3. Anotar el cambio en el registro de `docs/Sofia-Base-de-Conocimiento.md`.

**Revertir:** restaurar `system_prompt` desde ese respaldo. Inmediato, sin desplegar
nada.

---

## 9. Cómo saber si sirvió

No se comprueba con "Probar a Sofía" ni con el chat web: ahí el prompt es el mismo
pero no se guarda nada y no hay `[PROGRAMAR]`. Se comprueba con la misma medición de
la sección 1, repetida dos semanas después:

- Cuántas veces Sofía recomendó esperar por peso **sin haber preguntado** el tamizaje:
  hoy 53 en 30 días. Tiene que bajar.
- Cuántas quedaron programadas por peso viniendo de ahí: hoy 23. Tiene que bajar.
- Y el control, para no haber roto lo otro: cuántas se programan por peso **después**
  de preguntar el tamizaje y recibir un sí. Hoy 227 recomendaciones por esa vía. **No
  tiene que bajar.**

Ese último número es el que avisa si la corrección se pasó de la raya y dejó de
proteger a quien sí tiene que esperar.
