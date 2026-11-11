# Que el tamizaje no suene a formulario

Fecha: 2026-11-11. Cambio al prompt, **preparado y verificado, pendiente de aplicar**:
el modo automático de la terminal bloqueó la subida. El texto está listo en
`.sofia/prompt.md` (fuera de git) y se aplica con un comando, al final de este
documento.

---

## El punto de partida

La paciente pide una cita y lo que recibe son tres preguntas sobre su cuerpo. El
tamizaje no es opcional —existe por una razón médica— pero **sonar a planilla sí es
evitable**, y hoy suena a planilla por tres motivos concretos, todos medidos sobre las
8.420 conversaciones con actividad entre el 2026-10-11 y el 2026-11-11.

### 1. El prompt le regalaba la frase hecha

La sección del tamizaje traía esto como ejemplo:

> "Antes de coordinar su valoración para [la cirugía] **necesito confirmarle un par de
> cosas rápidas**, para asegurarnos de que sea el mejor momento. ¿Está embarazada…?"

Resultado: **1.162 mensajes** con esa frase en 30 días. No está razonando mal, está
copiando el ejemplo — exactamente lo que ya se había visto en la entrada del 10 de
noviembre del registro, donde el 88% de los tamizajes mal aplicados usaban esa misma
frase literal.

### 2. Juntaba preguntas, y eso borra las respuestas

**222 de 1.415 conversaciones (15,7%)** pusieron dos o tres preguntas del tamizaje en
el mismo mensaje. El prompt decía "nunca **las tres** en el mismo mensaje", lo que deja
leer que dos están bien.

Y no es solo incomodidad: cuando van juntas se pierde el **48%** de las respuestas
contra el 40% cuando van de a una, porque el clasificador —con razón— no guarda un
dato clínico que no se puede atribuir a una pregunta concreta.

### 3. Un residuo de preguntas ya contestadas

El arreglo del 1 de noviembre funcionó: hoy se le pregunta por embarazo a alguien que
ya dio su edad en el **0%** de los casos, y por lactancia en el **2%**. Pero esas 21
preguntas restantes son a señoras de **55 a 64 años**, y a mujeres que acababan de
contar que les quitaron el útero. El párrafo daba como ejemplos "60 o 68 años" y el
hueco quedó justo debajo.

---

## Lo que se cambia

Tres ediciones, todas dentro de la sección de screening. Nada fuera de ahí.

### a) "nunca las tres" → "nunca dos"

> **CÓMO: de una en una, nunca dos en el mismo mensaje.** Ni dos ni tres: una. […]
> Está medido sobre 30 días de conversaciones reales: cuando las juntas, se pierde casi
> la mitad de las respuestas, porque un dato clínico ambiguo no se puede guardar.
> Preguntarle de más y quedarte igual sin el dato es lo peor de los dos mundos.

### b) Se quita la frase hecha y se pone el criterio

El ejemplo literal desaparece. En su lugar:

> **CÓMO SE SIENTE DEL OTRO LADO, QUE ES LO QUE SE HACÍA MAL.** Esa paciente acaba de
> pedir una cita. Lo que recibe a cambio son tres preguntas sobre su cuerpo, y si se
> las haces en tono de trámite, la conversación se le convierte en un formulario justo
> en el momento en que ella decidió avanzar. El tamizaje no es opcional, pero sonar a
> planilla sí es evitable.
>
> Entonces la primera pregunta se engancha con lo último que ella te dijo, nombra la
> cirugía concreta de la que están hablando […] y dice en la misma frase para qué sirve
> el dato. Las que siguen van cortas, sin volver a explicar el procedimiento entero y
> sin agradecer cada respuesta como si fueras un mostrador.
>
> **No tienes una frase fija para abrir el tamizaje y no debes inventarte una.**
> Escríbela distinta cada vez, con lo que esa conversación traiga. Si notas que estarías
> escribiendo otra vez las mismas palabras con las que abriste el tamizaje de otra
> paciente, esa es la señal de que lo estás haciendo mal: no es una fórmula, es una
> conversación.

La prueba que el ejemplo cumplía —nombrar el procedimiento sirve para detectar que el
filtro no aplica— **se conserva**, en su propio párrafo, sin la frase.

### c) El residuo de la edad

Al párrafo de "revisa si la conversación ya la contestó" se le agregan los casos
medidos: "56, 60 o 68 años", y que le hayan quitado el útero, la menopausia, o que el
hijo menor ya tenga varios años.

---

## Lo que NO se cambia

- Las tres preguntas, cuáles son y cuándo se hacen.
- Que el tamizaje **no es opcional** y no se pide permiso para hacerlo. Pedir permiso
  para algo que vas a hacer igual no es pedir permiso. El permiso pertenece a las
  preguntas nuevas de la preclasificación, que sí son opcionales — ver abajo.
- Las zonas donde aplica, la prohibición de conducta fuera de ellas, el `[PROGRAMAR]`,
  los precios y las reglas institucionales.

---

## Una corrección a lo que se dijo antes sobre el permiso

En la conversación de diseño quedó dicho que el permiso sería **uno solo y cubriría
todo, incluidas las tres preguntas de hoy**. Eso estaba mal y se corrige acá:

> El tamizaje es obligatorio. Preguntar "¿le parece bien si le hago unas preguntas?" y
> después hacerlas igual si dice que no, no es pedir permiso: es simular que se pide.

El permiso se queda donde tiene sentido: **antes de las preguntas nuevas de la
preclasificación**, que sí se pueden saltar sin consecuencia. Secuencia definitiva,
cuando haya criterios cargados:

| turno | qué pasa |
|---|---|
| la paciente pide la cita | — |
| Sofía | tamizaje 1, enganchado con lo que ella dijo |
| Sofía | tamizaje 2, corta |
| Sofía | tamizaje 3, corta |
| Sofía | **pide permiso** para las preguntas nuevas, y espera |
| Sofía | pregunta nueva 1 (solo si dijo que sí) |
| Sofía | traspaso con el caso escrito |

Con la hoja de criterios vacía, los dos últimos pasos no existen y la conversación
termina en el traspaso, como hoy.

---

## Cómo aplicarlo

El texto ya está preparado en `.sofia/prompt.md`, con su huella verificada contra
producción. Un solo comando, desde `cecmarketing`:

```bash
node scripts/sofia-base.mjs subir prompt "que el tamizaje no suene a formulario: fuera la frase hecha, nunca dos preguntas juntas, y el residuo de la edad"
```

El script guarda el respaldo en `sofia_config_backups` **antes** de tocar nada, y se
niega a subir si el prompt cambió en producción desde que se bajó.

**Revertir:** restaurar `system_prompt` desde ese respaldo. Inmediato, sin desplegar.

---

## Cómo se sabrá si sirvió

Repetir la medición en dos semanas, sobre los mensajes de Sofía:

| | hoy | qué se espera |
|---|---|---|
| mensajes con "un par de cosas rápidas" | 1.162 | cerca de cero |
| conversaciones con dos preguntas del tamizaje juntas | 222 (15,7%) | bastante menos |
| respuestas del tamizaje que se guardan | 58% | más, porque se pierden menos por ambigüedad |
| preguntas de lactancia a señoras de 55+ | 21 | cero |

Y el control que **no** debe moverse: que se sigan haciendo las tres preguntas donde
corresponde. Si bajan las preguntas en total, el cambio se pasó de la raya.
