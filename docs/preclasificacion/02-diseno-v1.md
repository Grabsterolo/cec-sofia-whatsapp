# Preclasificación de pacientes — Parte 2: diseño de la v1

Fecha: 2026-11-11. Rama: `feature/preclasificacion`, sobre `main` = `origin/main` =
`6c581a7`. **No se modificó código.**

Este documento reemplaza el alcance propuesto en el planteo original donde la
auditoría o una medición nueva mostró que no se sostenía. Cada cambio está
justificado con el dato o con la decisión de JP que lo motivó; nada se recortó por
comodidad.

Los otros dos entregables de esta parte: [`03-propuesta-sql.md`](03-propuesta-sql.md)
y [`04-prompt-propuesto.md`](04-prompt-propuesto.md).

---

## 1. Las cuatro decisiones que JP tomó para este diseño

Las seis decisiones que quedaron abiertas en la auditoría se resolvieron así:

| # | decisión | qué se decidió |
|---|---|---|
| 1 | Commits sin subir | No existía: era una referencia vieja del remoto. Cerrada. |
| 2 | Alcance frente a la prohibición de conducta del prompt | **Las preguntas nuevas viven solo en las zonas del tamizaje actual** (senos, abdomen, cintura, espalda, glúteos, brazos, muslos). La prohibición vigente no se reescribe. |
| 3 | Prefijo en `escalation_reason` | **Sin prefijo en la v1.** El motivo médico se escribe con las palabras que el dashboard ya entiende. El prefijo espera a la v2. |
| 4 | El tope de 10 turnos | **Las preguntas clínicas no consumen tope** (cómo, en 4.6). |
| 5 | Cuándo se calcula la preclasificación | **Se arregla la captura y es la fase 1 del trabajo** (4.1). |
| 6 | Respaldo de los criterios | Se propone respaldarlos igual que el prompt; el SQL está en `03`. |

Y una quinta decisión, que JP pidió resolver con evidencia y no con criterio propio:
**cómo se obtiene un dato clínico sensible sin preguntarlo de frente.** Está en la
sección 3.

---

## 2. Lo que se midió para este diseño

Universo: las **8.420 conversaciones de WhatsApp con actividad entre el 2026-10-11 y
el 2026-11-11**, leídas completas (mensajes de la paciente y de Sofía), cruzadas con
su fila de `sofia_conversations`. El método y sus límites, al final del documento.

### 2.1 El peso casi nunca llega como número

| | conversaciones | % |
|---|---|---|
| la paciente dice su peso en kilos | 109 | 1,3% |
| dice su estatura | 35 | 0,4% |
| **dice las dos — se puede calcular un IMC** | **31** | **0,4%** |

Dentro de las zonas del tamizaje: 102 con peso, **30 con las dos**.

Y cuando Sofía sí abre el tema del peso (la tercera pregunta del tamizaje, que no
pide cifras): de 931 conversaciones, **65 pacientes contestaron con una cifra (7,0%)**.

**Consecuencia de diseño: el IMC no puede ser la puerta de la preclasificación.** Con
30 conversaciones útiles en un mes, un flujo que dependa del IMC no clasifica a
nadie. El IMC pasa a ser un dato de oportunidad: se guarda cuando existe y no se
exige nunca.

### 2.2 Lo que la paciente sí cuenta, y lo que Sofía ya pregunta

Sofía hace al menos una pregunta de historia o contexto ("¿desde cuándo lo nota?",
"¿fue después de una baja de peso?", "¿qué le gustaría lograr?") en **2.418
conversaciones (29%)**, y la paciente contesta algo con sustancia en **1.667 de ellas
(69%)**.

Señales clínicas que la paciente suelta **sin que nadie le pregunte**, en 472
conversaciones (6% del total, y mucho más alto dentro de las zonas):

| señal | conversaciones |
|---|---|
| embarazos o partos | 256 |
| cambio de peso importante | 169 |
| cirugía previa | 62 |
| condición crónica o medicamento | 38 |
| fuma | 1 |

**Consecuencia de diseño: el canal que funciona es la historia, no la cifra.** La
pregunta por el origen de lo que le molesta produce información clínica real, la
produce en el 69% de los casos y no cuesta un turno nuevo, porque Sofía ya la hace.

### 2.3 El tamizaje de hoy pierde el 42% de lo que pregunta

De las 1.415 conversaciones donde Sofía preguntó al menos un tema del tamizaje: se
hicieron **3.184 preguntas** y quedaron guardadas **1.848 (58%)**. El reparto explica
el porqué:

| | conversaciones | preguntas | guardadas |
|---|---|---|---|
| escaló y la paciente contestó | 811 | 2.024 | **81%** |
| escaló y no contestó | 98 | 160 | 20% |
| **no escaló y la paciente contestó** | **306** | **687** | **23%** |
| no escaló y no contestó | 200 | 313 | 4% |

**306 conversaciones en 30 días en las que una paciente contestó una pregunta clínica
y el dato se perdió.** La causa está en el código, no en el modelo:
`processInboundMessage()` (`src/index.js:2022`) deja de reclasificar desde el tercer
mensaje cuando ya hay un procedimiento concreto, y el tamizaje ocurre en el turno
cinco u ocho. Solo vuelve a correr en la rama de escalamiento — de ahí el 81% contra
el 23%.

**Consecuencia de diseño: esto se arregla antes de agregar una sola pregunta nueva.**
Es la fase 1 (4.1). Sin eso, lo que recoja el flujo nuevo se pierde en las mismas
proporciones.

### 2.4 Una de cada seis veces, el tamizaje se hace mal

En **222 de las 1.415 conversaciones (15,7%)** Sofía puso dos o tres preguntas del
tamizaje en un mismo mensaje, que es exactamente lo que el prompt prohíbe y lo que el
clasificador castiga con `null` en las tres. La pérdida lo confirma: **48% cuando van
juntas contra 40% cuando van de a una.**

Y hay una causa identificada en el propio prompt. La sección del tamizaje **le entrega
a Sofía la frase hecha** como ejemplo:

> "Antes de coordinar su valoración para [la cirugía] necesito confirmarle un par de
> cosas rápidas…"

y cuatro párrafos antes **prohíbe esa misma frase** como reformulación donde la
sección no aplica. El resultado está medido: **1.162 mensajes** la usan. Es una
muletilla, y es la que convierte el tamizaje en formulario. Se trata en `04`.

### 2.5 Un dato que la auditoría dejó pendiente

El tamizaje se aplicó a un tratamiento **no quirúrgico** (Morpheus8, Ultherapy,
FaceTite) en **26 conversaciones**. Es poco —1,8% de las que tamizan— pero el prompt
lo prohíbe con todas las letras. No es parte de este trabajo; queda anotado.

---

## 3. Cómo se pregunta un dato clínico sensible — lo que dice la literatura

JP pidió que esto no se improvisara. La respuesta de la literatura de servicio médico
y psicológico es más precisa que "preguntar" o "no preguntar": **el problema no es la
pregunta, es la forma.** Y tiene un hallazgo que corrige la intuición de partida.

### 3.1 El permiso va antes del tema, no antes del número

En el marco de las **5A para el manejo de la obesidad** (Obesity Canada), el primer
paso, *Ask*, no es preguntar el peso: es **pedir permiso para hablar del peso**
("¿Le parece bien si hablamos de su peso?"). Si la persona dice que no, no se insiste;
como mucho se le pregunta si estaría abierta a retomarlo más adelante, y la decisión
queda de su lado. La sustitución de *Arrange* por *Ask* se hizo justamente para
reducir la culpa y el estigma en esa conversación.

### 3.2 Cada pregunta se justifica, y el "paso" se ofrece en voz alta

Una revisión de co-diseño de herramientas de autoevaluación por chatbot encontró que
los participantes querían **cada pregunta de salud justificada**, redactada con
empatía, con aviso previo cuando el tema es incómodo y **con la opción explícita de
saltarla**. No basta con aceptar una negativa: hay que nombrar que saltarla es una
opción.

### 3.3 La gente le cuenta más a una máquina que a una persona

Esto es lo que corrige la intuición. Un metaanálisis de 39 estudios encontró que la
administración por computadora **aumenta** la autorrevelación, con efecto mayor
justamente en pacientes médicos y psiquiátricos; un estudio de severidad de consumo
encontró más revelación en la versión autoadministrada que con un entrevistador
entrenado en cinco de siete dominios. El fenómeno tiene nombre —*disclosure
advantage*— y se atribuye a la menor inhibición social.

No es unánime: un ensayo de 2008 en pacientes con enfermedad mental grave no encontró
esa ventaja y en algunas medidas la encontró al revés. Y las entrevistas por
computadora tienen límites conocidos: no leen lo no verbal, producen más falsos
positivos que un clínico, y hay gente que simplemente se niega a usarlas.

**Lo que esto significa para Sofía: que sea un bot el que pregunta no es, por sí
mismo, peor que una persona. Puede ser mejor tolerado** — si se cumplen las
condiciones de 3.1 y 3.2.

### 3.4 Lo que sí hace daño

La literatura de estigma de peso es consistente: atribuir los problemas de la paciente
a su cuerpo, o recomendarle bajar de peso como condición, se recibe como juicio, daña
la relación y **hace que la paciente evite la consulta**. El principio operativo que
sale de ahí, y que además coincide con la minimización de datos de 3.2: **no se pide
un dato que no vaya a cambiar lo que pasa después.**

### 3.5 Lo que el chatbot debe decir de sí mismo

Las guías de diseño coinciden en: identificarse como asistente y no como reemplazo de
la atención médica, decir para qué sirve el dato, y **ofrecer el paso a una persona —
especialmente cuando la paciente duda o aparece un tema sensible.** Sofía ya hace las
tres cosas; el bloque nuevo no las afloja.

### 3.6 La regla que sale de todo esto

> **Sofía puede preguntar un dato clínico, pero solo detrás de un permiso, con el
> porqué dicho, con el "si prefiere no decirlo, no hay problema" ofrecido en voz alta,
> sin comentar nunca la respuesta — y solo si ese dato cambia lo que pasa después.**

Y de ahí sale la decisión para la v1, que coincide con la intuición de JP por un
camino distinto: **en la v1 no hay ningún criterio médico aprobado, así que ningún
dato clínico cambia lo que pasa después. Por lo tanto en la v1 Sofía no pide cifras:
escucha.** La maquinaria para preguntar se construye detrás del permiso y se enciende
con el primer criterio que aprueben los cirujanos, no antes.

### 3.7 Las fuentes

- 5A de manejo de la obesidad, el paso *Ask* y el permiso previo: [marco de las 5A](https://pmc.ncbi.nlm.nih.gov/articles/PMC3555649), [Obesity Canada](https://obesitycanada.ca/?p=2697), [revisión de aplicación clínica](https://pmc.ncbi.nlm.nih.gov/articles/PMC8085475/), [ejemplos de redacción del permiso](https://pmc.ncbi.nlm.nih.gov/articles/PMC3792831/table/t6-ijwh-5-629), [Advances in Therapy](https://link.springer.com/article/10.1007/s12325-021-01748-0).
- Ventaja de revelación ante una máquina: [metaanálisis de autorrevelación en formularios por computadora](https://experts.arizona.edu/en/publications/self-disclosure-on-computer-forms-meta-analysis-and-implications/), [entrevista paciente-computadora](https://www.mayoclinicproceedings.org/article/S0025-6196(11)61832-6/fulltext), [severidad de consumo autoadministrada](https://pubmed.ncbi.nlm.nih.gov/20161486/). El resultado en contra: [ensayo de 2008 en enfermedad mental grave](https://psychiatryonline.org/doi/10.1176/ps.2008.59.7.769).
- Diseño de preguntas sensibles en chatbots de salud: [co-diseño de autoevaluación asistida por chatbot (PLOS Digital Health)](https://journals.plos.org/digitalhealth/article?id=10.1371%2Fjournal.pdig.0000724), [desinhibición y revelación ante chatbots médicos](https://doi.org/10.3390/healthcare14091218).
- Estigma de peso y candidatura quirúrgica: [AMA Journal of Ethics](https://journalofethics.ama-assn.org/article/should-bmi-help-determine-gender-affirming-surgery-candidacy/2023-07).

---

## 4. El diseño

Nueve piezas, en orden de implementación. Las fases 1 a 3 valen por sí solas aunque
los criterios médicos no lleguen nunca; de la 4 en adelante, nada se activa con la
lista de procedimientos vacía.

### 4.1 Fase 1 — arreglar la captura (sin esto, lo demás no se mide)

**Qué pasa hoy.** `yaClasificada` (`src/index.js:2022`) es verdadero desde el tercer
mensaje cuando ya se conoce el procedimiento, y entonces no se llama al clasificador.
El tamizaje y la preclasificación ocurren después de ese punto.

**Qué se cambia.** Una condición más, de alcance mínimo: no se saltea la
clasificación cuando **las tres cosas** se cumplen a la vez.

1. La conversación está en una zona del tamizaje (el mismo criterio de 4.3).
2. Queda algún dato clínico sin valor (`tamizaje_*` en `null`, o un campo nuevo de la
   preclasificación en `null`).
3. **El mensaje anterior de Sofía hizo una pregunta clínica.** Esta es la que evita
   pagar de más: solo se reclasifica el turno en que hay una respuesta que capturar.

**Lo que cuesta.** El atajo ahorra hoy ~$13/mes (38,8% de los turnos). Las preguntas
clínicas medidas en 30 días son 3.184, así que el techo del gasto nuevo son ~3.184
clasificaciones al mes: **unos $4 mensuales**. Es el precio de no perder el 42%.

**Lo que no se toca.** El arrastre de valores guardados cuando sí se saltea
(`agility = { procedureInterest: …, sentiment: …, tamizaje: SIN_TAMIZAJE }`) se queda
igual: ese bloque existe porque devolver un objeto vacío borraba el procedimiento y
sacaba a la paciente de la cola de Seguimiento.

**Cómo se verifica que sirvió.** La misma consulta de 2.3, dos semanas después: la
captura del grupo "no escaló y contestó" tiene que subir del 23% hacia el 81% del
grupo que escala. Es una medición, no una prueba sintética — las redes de respaldo no
se prueban simulando.

### 4.2 Fase 2 — el interruptor, los criterios y la lista

Tres columnas nuevas en `sofia_config` (SQL en `03`):

| columna | para qué |
|---|---|
| `preclasificacion_enabled` (boolean, default `false`) | prende y apaga sin desplegar, igual que `followup_enabled`. Apagado, Sofía se comporta exactamente como hoy. |
| `preclasificacion_procedimientos` (text[], default `{}`) | la lista de procedimientos con criterio aprobado. **Arranca vacía.** |
| `preclasificacion_criterios` (text) | el texto de los criterios médicos, con su versión y fecha dentro. |

**Dónde se leen.** En el mismo `select` de `loadSofiaConfig()` (`:2701`). Sin costo
por mensaje.

**Dónde va el texto de los criterios.** Concatenado al final del bloque del prompt,
como recomendó la auditoría: llega en el 100% de los mensajes y no consume el cuarto
y último slot de caché. El costo es un re-escrito del caché el día que los cirujanos
cambien un criterio, con TTL de 1 hora.

**Dos frenos, no uno.** Es el conflicto 6.10 de la auditoría: la lista vacía apagaba
la clasificación pero no la conversación. Se cierra por los dos lados, porque el
primero es una instrucción y un modelo puede aplicarla mal, y el segundo es código y
no se equivoca.

- **El bloque del prompt se autodesactiva.** Su primer párrafo dice que la sección
  entera no existe si no aparece más abajo un bloque `CRITERIOS APROBADOS`. Con la
  lista vacía ese bloque no llega nunca y el texto queda inerte. Por eso el bloque sí
  vive en `system_prompt` —un solo punto de inserción, como pide el planteo— y cuesta
  solo unos 450 tokens dentro del bloque que ya se cachea.
- **El código no inyecta los criterios** si el interruptor está apagado, si la lista
  está vacía, o si `preclasificacion_criterios` está vacío. El último caso deja un
  `console.warn`: una lista con procedimientos y sin criterios es un error de
  configuración, no un estado válido.

### 4.3 Fase 3 — la conversación

Todo esto aplica **solo** dentro de la intersección de dos condiciones: el
procedimiento está en `preclasificacion_procedimientos`, **y** la conversación está en
las zonas del tamizaje actual (cirugía de la sección 4 que reforma senos, abdomen,
cintura, espalda, glúteos, brazos o muslos). Fuera de ahí, nada de esta sección
existe. Es la decisión 2 de JP y por eso la prohibición de conducta del prompt vivo no
se reescribe.

**Las reglas, en orden:**

1. **Primero informar.** Mientras la paciente se informa, no hay preguntas clínicas.
   Ya es la regla del tamizaje y no cambia.
2. **El permiso va antes del tema.** La primera vez que Sofía va a entrar en terreno
   clínico, pide permiso en una frase y espera. Un "no" cierra el tema sin
   consecuencias: la conversación sigue y el traspaso sigue.
3. **Cada pregunta dice para qué sirve**, en la misma frase, antes de preguntar.
4. **Cada pregunta ofrece el paso en voz alta**: que no contestar es una opción
   legítima y no cambia nada de lo que sigue.
5. **Una pregunta por mensaje.** Ya es la regla; lo que cambia es que ahora hay una
   razón medida para insistir en ella (2.4).
6. **Lo que la paciente ya dijo no se vuelve a preguntar**, en ningún punto de la
   conversación. Ya es la regla.
7. **Nunca se pide una cifra del cuerpo** — ni peso, ni estatura, ni talla, ni IMC —
   **mientras no haya un criterio aprobado que use ese número.** Hoy no hay ninguno,
   así que hoy no se pide ninguna. Es la regla de 3.4 y 3.6.
8. **Lo que la paciente cuente de su historia se recoge.** Las preguntas por el origen
   —desde cuándo, después de qué— no son preguntas clínicas: son las que Sofía ya hace
   para orientar, y son el canal que funciona (2.2). Siguen siendo de ella.
9. **El IMC, si existe, no se le menciona nunca.** Ni el peso que la paciente dio. No
   se repite de vuelta, no se comenta, no se usa para justificar nada frente a ella.
10. **Si pide hablar con una persona, se escala de inmediato**, en cualquier etapa.
    Ya es la regla.
11. **Una negativa nunca clasifica en contra.** Si no quiere dar un dato, el caso va a
    revisión médica, nunca a "no cumple".

**Cuántas preguntas.** Como máximo **tres** preguntas clínicas nuevas además del
tamizaje, y cada una tiene que estar nombrada en `preclasificacion_criterios`. Sofía
no inventa preguntas: pregunta lo que los criterios digan que hace falta, en el orden
en que estén escritas. Con la columna vacía, cero preguntas nuevas.

**Por qué esto no es la frase hecha otra vez.** El bloque del prompt no trae ningún
texto para copiar. Trae el dato y el criterio: qué pedir permiso, qué justificar, qué
ofrecer, qué no decir nunca. La redacción es de Sofía en cada conversación. La
medición de 2.4 es la prueba de qué pasa cuando el prompt le da la frase.

### 4.4 Fase 4 — la clasificación: el modelo extrae, el código clasifica

Esta es la pieza que mantiene la regla de no inventar criterios médicos.

**El clasificador (Haiku) no clasifica el caso.** Se le agregan campos que son
**hechos observados en la conversación**, nunca juicios clínicos:

| campo nuevo | qué es | valor por defecto |
|---|---|---|
| `senales_clinicas` | lista cerrada de categorías presentes en lo que dijo la paciente: `cambio_peso`, `embarazo_o_parto_reciente`, `cirugia_previa`, `condicion_cronica`, `anticoagulante`, `fuma`, `sintoma_de_alarma` | `[]` |
| `peso_kg` / `estatura_cm` | solo si la paciente los dijo | `null` |
| `respuestas_clinicas` | qué preguntas de los criterios quedaron contestadas | `[]` |
| `permiso_clinico` | `true` / `false` / `null` según lo que respondió al permiso | `null` |

Reglas idénticas a las del tamizaje: ante la duda, `null`; un dato clínico inventado
es peor que uno ausente; y la regla dura de atribución (si se preguntaron dos cosas
juntas y contestó "no", va `null`). La lista de `senales_clinicas` es **cerrada**: el
modelo no escribe texto clínico libre, ni para la base ni para la nota.

**El código clasifica**, con los criterios de la columna:

| estado | cuándo | qué hace Sofía |
|---|---|---|
| **A. cumple** | ningún criterio aprobado se activa y no falta nada | escalamiento comercial, como hoy |
| **B. revisión médica** | hay una señal, falta un dato, la paciente se negó, o el criterio no está aprobado | le dice que su caso lo revisa el equipo y escala con motivo médico |
| **C. no cumple** | un criterio aprobado aplica sin duda | **en la v1 no se le comunica**: se trata como B y una persona da la noticia |
| **D. prioritaria** | señal de alarma o posible complicación | protocolo de seguridad (`PENDIENTE_APROBACION_MEDICA`), sin proceso comercial |
| **en espera** | lo que hoy cubre `[PROGRAMAR]` | sin cambios |

Con la lista vacía, el código no puede producir C ni D por criterio: solo A o B. D
sigue llegando por la vía que ya existe (síntomas post-operatorios y emergencias,
`:131`-`:145`), que no depende de este flujo.

**El IMC.** Se calcula solo si el clasificador devolvió peso y estatura, se guarda
redondeado a un decimal, y **el peso y la estatura crudos no se guardan** (4.8). Si
falta uno de los dos, no hay IMC y no se exige.

### 4.5 Fase 5 — el escalamiento y el texto del motivo

Se reutiliza `[ESCALAR: motivo]` tal cual. No hay mecanismo nuevo, no hay etiqueta
nueva, y `[ESCALAR]`, `[NO_RESPONDER]`, `[CERRAR]` y `[PROGRAMAR]` no se tocan.

**Sin prefijo** (decisión 3 de JP). El motivo se escribe de forma que el dashboard lo
clasifique bien **sin tocar ninguna pantalla**, y eso impone una forma concreta:

- Tiene que contener las palabras que ya puntúan y agrupan. `agendar`, `cita`,
  `valoración` valen 40 en el puntaje de la cola y caen en "Solicitó una valoración".
- La parte médica va en palabras, no en etiqueta: *"agendar valoración de
  abdominoplastia; el equipo médico debe revisar un cambio de peso reciente; falta
  confirmar lactancia"*.
- Para el estado D se mantiene la palabra que `MOTIVO_URGENTE` (`:135`) ya reconoce,
  para que nunca se difiera de noche.

Esto resuelve la contradicción 6.5 de la auditoría: un motivo con prefijo `médico:`
puntuaba cerca de cero y caía al fondo de la cola de Seguimiento. Así no.

**Dos cosas quedan anotadas como deuda, no como alcance:**

- La divergencia entre `MOTIVO_URGENTE` del Worker y la regla `urgente` de la vista
  `sofia_followup_queue`, que no dicen lo mismo.
- La palabra `molest[ao]` dentro de `MOTIVO_URGENTE`: hoy una paciente que se molesta
  por las preguntas se clasifica como urgente. El caso 7 de las pruebas lo va a
  mostrar; no se cambia nada sin decidirlo aparte.

**El destinatario.** Mismo pool de 4 asesores por round-robin, como pide el planteo.
La nota de Zenvia sigue llevando solo el motivo, en una o dos líneas.

### 4.6 Fase 6 — el tope de turnos

Decisión 4 de JP: las preguntas clínicas no consumen tope. La implementación **no toca
`message_count`**, porque ese contador lo leen otras pantallas y tiene que seguir
diciendo cuántos mensajes hubo. Lo que se mueve es el techo:

> `tope efectivo = MAX_CONVERSATION_TURNS + preguntas clínicas que Sofía hizo en esta
> conversación`, con un máximo de **+4**.

Las preguntas clínicas se cuentan leyendo el historial que ya está en memoria: no hace
falta columna nueva. El tope de noche (20) no cambia. El límite de +4 existe para que
una conversación que se va por la rama no se vuelva infinita: el tope también protege
el gasto.

**Lo que esto evita**, medido en la auditoría: con tres preguntas más y el tope
intacto, el 43,4% de las pacientes que contestan el tamizaje habría cerrado por
`límite de mensajes alcanzado`, un motivo que el dashboard cuenta como "Cierre del
sistema" y la cola puntúa como mecánico.

### 4.7 Fase 7 — las tres colas de respaldo

La tercera cola (`ofrecimiento_sin_respuesta_desde`) detecta hoy que Sofía dejó algo
pendiente con cuatro expresiones regulares atadas al **texto** de las tres preguntas
actuales (`PREGUNTAS_DEL_TAMIZAJE`, `:2316`). Las preguntas de la preclasificación no
tienen texto fijo —salen de los criterios— así que una regex no sirve.

**El cambio:** se generaliza el disparador. Cuando el flujo nuevo está activo para esa
conversación y el mensaje de Sofía termina en pregunta, la fila se marca. No depende de
qué palabras usó.

Esto va **en el mismo commit** que las preguntas nuevas. Es el agujero que se midió en
130 conversaciones al mes, se cerró el 10 de noviembre, y una pregunta nueva sin esto
lo reabre por la puerta de al lado.

También hay que revisar `difiereAlEquipo()` (`:2368`) contra las frases nuevas: si una
pregunta clínica lleva a Sofía a escribir "eso lo confirma el equipo médico", hoy se
dispara un traspaso con el motivo `difirió el precio al equipo sin etiqueta
[ESCALAR]`, que sería falso.

### 4.8 Fase 8 — los datos

Cuatro columnas nuevas en `sofia_conversations`, con el SQL, el impacto y la reversión
en `03-propuesta-sql.md`. Lo que importa del diseño:

- **Minimización.** Se guardan la clasificación, el IMC redondeado, las categorías de
  señal (lista cerrada) y la versión de criterios aplicada. **No se guardan el peso ni
  la estatura crudos, ni texto clínico libre.** Si mañana cambia la fórmula del IMC, se
  recalcula de las conversaciones, no de la base.
- **Pegajosidad.** Igual que el tamizaje (`:3836`): un dato clínico que ya se obtuvo no
  se borra en el turno siguiente. La lección del 29 de setiembre con
  `escalation_reason`.
- **Sin `CHECK` nuevo.** Los valores válidos se validan en el código. Un `CHECK` sin su
  migración rechaza cada insert y no deja rastro si nadie mira la respuesta: es el mes
  perdido del diagnóstico de atribución. El costo de no tenerlo es un valor raro en una
  columna; el costo de tenerlo mal es perder la escritura entera.

### 4.9 Fase 9 — el dashboard: propuesta, sin código

Nada de código en la v1. Lo que se propone mostrar, reutilizando lo que ya existe:

- **Métricas Sofía**: un recuadro con el reparto A / B / D del período y la cobertura
  (de las conversaciones que entraron al flujo, en cuántas quedó algo registrado). Ese
  segundo número es el que dice si la fase 1 sirvió.
- **Seguimiento**: la señal clínica como una línea más de la ficha de la paciente, al
  lado del tamizaje. No una columna nueva ni un filtro nuevo.
- **Nada en Inicio.** Inicio gira alrededor de un período y de un embudo; esto no es
  una etapa del embudo.

### 4.10 Las pruebas

**El arnés.** El repo no tiene pruebas y no se pueden agregar dependencias. El arnés va
a ser un script propio (`scripts/arnes-preclasificacion.mjs`) que reemplaza `fetch` por
una versión que enruta por dominio:

| destino | qué hace el arnés |
|---|---|
| `*.supabase.co` | tablas en memoria; se puede inspeccionar qué se escribió |
| Zenvia | registra la llamada y no manda nada |
| `api.anthropic.com` | respuestas guionadas por caso |

Así se ejercita el camino real del Worker —webhook, parseo, redes, colas, guardado—
sin escribirle a nadie. Llamadas reales a Claude solo con autorización expresa y con
una variable de entorno aparte.

**Los 16 casos del planteo**, con lo que cada uno tiene que demostrar:

| # | caso | qué se verifica |
|---|---|---|
| 1 | cumple los criterios iniciales | sale A, escalamiento comercial, motivo con las palabras que el dashboard agrupa |
| 2 | IMC elevado | **con la lista vacía sale B, no C**; el IMC no se le menciona |
| 3 | obesidad + antecedentes | B; las señales quedan como categorías, sin texto clínico libre |
| 4 | peso elevado con información incompleta | B; el motivo dice qué falta |
| 5 | procedimiento fuera de la lista | idéntico a hoy; el bloque queda inerte y no llegan criterios |
| 6 | se niega a dar el peso | se respeta, no se repregunta, **B y nunca C** |
| 7 | se molesta por las preguntas | Sofía para; y se observa si `molest[ao]` la vuelve urgente (4.5) |
| 8 | pide hablar con una persona | escala de inmediato, en cualquier etapa |
| 9 | antecedentes quirúrgicos complejos | B con la señal `cirugia_previa` |
| 10 | síntomas de alarma | D, protocolo, sin proceso comercial, motivo que calza con `MOTIVO_URGENTE` |
| 11 | cambia de procedimiento a mitad | la clasificación se recalcula; si el nuevo no está en la lista, el flujo se apaga |
| 12 | ya dio la información antes | no se repregunta nada |
| 13 | interruptor apagado | byte por byte igual que hoy |
| 14 | lactancia o embarazo | sigue saliendo `[PROGRAMAR]`, sin cambios |
| 15 | llega al tope a mitad del flujo | el tope efectivo da el espacio (4.6) y no cierra con motivo mecánico |
| 16 | pregunta solo precio u horario | cero preguntas clínicas |

**Y tres pruebas de regresión que no están en el planteo**, por lo que se midió:

| # | caso | por qué |
|---|---|---|
| 17 | Sofía pregunta y la paciente contesta, **sin que la conversación escale** | es el 23% de 2.3: el dato tiene que quedar guardado |
| 18 | Sofía pregunta y la paciente no vuelve a escribir | la tercera cola tiene que marcar la fila (4.7) |
| 19 | la respuesta de Sofía difiere algo al equipo médico | no debe disparar el motivo falso de precio diferido |

---

## 5. Lo que NO entra en la v1

Para que el alcance quede cerrado:

- **El prefijo en `escalation_reason`** y, con él, cualquier cambio a `motivos.js`, a
  `sofia_home_stats` y a la vista `sofia_followup_queue`.
- **El destinatario médico del traspaso.** Va al mismo pool de asesores.
- **Decirle a la paciente que no cumple** (estado C). Lo dice una persona.
- **Cualquier criterio médico.** Los traen los cirujanos.
- **Pedirle cifras del cuerpo a la paciente.** Queda la maquinaria detrás del permiso,
  apagada hasta que un criterio aprobado use un número (3.6).
- **El tamizaje aplicado a tratamientos no quirúrgicos** (2.5) y la divergencia de
  `urgente` entre el Worker y la vista (4.5). Anotados, no arreglados acá.
- **Código de dashboard.**
- **Quitarle a Sofía la frase hecha del tamizaje.** Está medido en 1.162 mensajes y
  propuesto en `04`, pero toca texto existente del prompt y por eso se decide aparte.

---

## 6. Riesgos que quedan

| riesgo | qué tan silencioso | qué lo contiene |
|---|---|---|
| El bloque nuevo hace que Sofía pregunte algo clínico fuera de las zonas | **muy silencioso**: nadie se queja | los dos frenos de 4.2, y el bloque solo aplica dentro de las zonas; el caso 5 lo prueba |
| Un quinto bloque con `cache_control` o un bloque nuevo antes de uno cacheado | el más caro: la factura se multiplica sin que Sofía responda distinto | los criterios van concatenados al bloque del prompt, no en uno nuevo; se vigila con `SOFIA_USAGE.cache_lectura` |
| Un campo nuevo mal parseado tira el `catch` del clasificador y se pierde también el tamizaje de ese turno | medio, hay `console.error` | valores por defecto en todos los campos nuevos; el caso 17 lo ejercita |
| La fase 1 gasta más de lo estimado | visible en la factura, con retraso | la condición 3 (solo cuando Sofía preguntó algo) y una medición del conteo de clasificaciones a la semana |
| La paciente se siente interrogada igual | **silencioso**: abandona y no dice por qué | el permiso, el porqué y el "si prefiere no decirlo" de 4.3; y que en la v1 no se pide ninguna cifra |
| El tope efectivo deja conversaciones largas sin asesor | medio | el techo de +4 |

---

## 7. Lo que falta de los cirujanos

Todo esto queda marcado como `PENDIENTE_APROBACION_MEDICA` y **nada del flujo se
enciende sin ello**:

1. **La lista de procedimientos** que entran al flujo, y en qué orden se habilitan.
2. **Los criterios por procedimiento**: qué hace que un caso necesite revisión médica
   y qué hace que no sea candidata. Con el umbral, si lo hay.
3. **Las preguntas**, hasta tres: qué hace falta saber, y qué se ve en la valoración.
4. **Si algún criterio necesita un número** (IMC u otro). De eso depende que la
   maquinaria de 3.6 se encienda o se quede apagada.
5. **El texto del protocolo de urgencia** (estado D): qué se le dice a una paciente con
   señales de alarma y a dónde va el caso.
6. **La razón que se le da** cuando el caso pasa a revisión médica, en lenguaje de
   paciente y sin diagnóstico.

---

## 8. Lo que queda para que JP decida

1. **Si se le quita a Sofía la frase hecha del tamizaje** (2.4 y `04`). Toca texto
   existente del prompt, por eso no está incluido.
2. **Si los criterios se respaldan** en `sofia_config_backups` como el prompt. Hoy esa
   tabla solo guarda `system_prompt`; el SQL para extenderla está en `03`. Sin eso, un
   criterio pisado no tiene vuelta atrás.
3. **Si la fase 1 se despliega sola y se mide dos semanas** antes de montar el resto
   encima. Es lo que recomienda este documento: es un arreglo de valor propio y su
   efecto se ve en un número que ya sabemos leer.

---

## Apéndice — cómo se midió

- **Universo**: `GET /rest/v1/sofia_whatsapp_sessions` y
  `GET /rest/v1/sofia_conversations`, ambos filtrados por `updated_at >= 2026-10-11`,
  paginados de 1.000 en 1.000 hasta agotar (8.420 y 8.437 filas). Solo lecturas, con la
  llave de servicio de `cecmarketing/.env.local`. Nada escrito en producción.
- **Zonas del tamizaje**: aproximación por expresión regular sobre el texto de la
  conversación (`abdominoplast|mamari|senos|mastopex|lipo|glúte|brazo|muslo|cintura|
  contorno|busto|pecho`). Como toda aproximación por nombre, tiene falsos positivos.
- **"Sofía preguntó X"**: se buscan los temas del tamizaje **dentro de spans
  interrogativos** (`¿…?`) de los mensajes de Sofía, no en el mensaje completo. La
  primera versión contaba el mensaje entero y daba 20,5% de preguntas juntas, inflado
  por los mensajes que **resumen** respuestas anteriores ("queda claro que no hay
  lactancia ni planes de embarazo… última pregunta: ¿…?"). Con spans baja a 15,7%. La
  cifra que vale es la segunda.
- **Captura (2.3)**: se cruza "qué temas preguntó Sofía" con los `tamizaje_*` de la
  fila de esa paciente. "Contestó" es que exista al menos un mensaje de la paciente
  después de la última pregunta; no verifica que haya contestado *esa* pregunta, así
  que el grupo "contestó" tiene algo de ruido hacia arriba.
- **Un límite que no se puede saltar**: los mensajes guardados **no tienen fecha
  propia**. Todo lo que se cuenta aquí es sobre conversaciones *con actividad* en la
  ventana, y el historial de una de ellas puede venir de meses atrás. Por eso no se
  reporta nada "de esta semana" a nivel de mensaje. Un ejemplo de lo que ese límite
  produce: aparecieron 60 mensajes diciendo "este mes de agosto tenemos una
  promoción", que parecían un error vivo. Se verificó contra el texto actual de la base
  —que hoy dice "Este mes los precios son los mismos" y no nombra ningún mes— y eran
  mensajes de agosto. No había error.
- **La literatura de la sección 3** se buscó en fuentes clínicas y revisiones; las
  referencias están en el cuerpo. Dos advertencias que vienen de las propias fuentes:
  la ventaja de revelación no es unánime (un ensayo de 2008 la encontró al revés), y
  buena parte de la guía de diseño de chatbots son estudios sueltos o literatura
  profesional, no un estándar establecido.
- **Código**: `src/index.js` en `feature/preclasificacion`, rebasada sobre `main` =
  `origin/main` = `6c581a7`. Los números de línea son de ese commit.
