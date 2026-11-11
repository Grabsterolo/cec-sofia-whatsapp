# Fase 3a — preguntar y registrar, sin consecuencias todavía

Fecha: 2026-11-11. Rama `feat/preclasificacion-medir-imc`. **No desplegado.**

El cirujano pidió considerar el IMC: *"operar pacientes con índice de masa corporal
por arriba de 30 incrementa considerablemente la tasa de complicaciones"*. JP decidió
que Sofía **pregunte y registre primero**, sin que el número cambie todavía lo que
pasa con la paciente, y que el screening de siempre siga funcionando igual.

---

## 1. Por qué medir antes de filtrar

En 30 días de conversaciones, solo **3 pacientes** dieron peso y estatura por su
cuenta. Una tenía IMC 37. **Con tres casos no se puede afirmar nada** — y eso es el
punto: cuando el cirujano dice que están llegando muchas pacientes con obesidad, nadie
en la clínica puede decirle cuántas, porque nadie lo pregunta.

Tres semanas de preguntar y registrar dan tres cosas que hoy no existen:

1. **El número real**: qué porcentaje de las que piden aumento mamario está sobre 30.
2. **El costo de la pregunta**: cuántas la contestan, cuántas se incomodan, cuántas
   abandonan ahí. Si la pregunta espanta gente, mejor saberlo antes de haberle colgado
   una consecuencia.
3. **Una decisión con datos**: si el umbral alcanzara a una fracción grande de las
   pacientes, eso es una decisión de negocio, y conviene tomarla mirando la cifra.

Y una razón de método: esto habilita la pregunta sin romper la regla que escribimos
hoy — *no se le pide a una paciente un dato que no vaya a cambiar lo que pasa
después*. Ahora cambia algo: el equipo médico va a definir un umbral con ese dato. Lo
que no cambia **todavía** es lo que le pasa a ella, y eso se le dice con la verdad.

---

## 2. El orden de la conversación

Primero el screening de siempre; la pregunta nueva solo llega a quien iba a quedar
agendada igual.

| turno | qué pasa |
|---|---|
| la paciente pide la cita | — |
| Sofía | screening 1, 2 y 3, una por mensaje, como hoy |
| *(si alguna sale positiva)* | se explica, se programa el seguimiento y **acá termina**: no se pregunta nada más |
| Sofía | **pide permiso**, dice para qué, ofrece no contestar, y espera |
| Sofía | peso y estatura, **los dos en una sola pregunta** |
| Sofía | traspaso, igual que siempre |

**Por qué el screening va primero:** a una paciente embarazada o en pérdida de peso
activa se la programa y nunca se le pregunta el peso — se ahorran dos turnos y una
pregunta incómoda. Y el denominador de la medición queda limpio: solo las que de
verdad iban a la cita.

**Por qué peso y estatura van juntos:** es la excepción a "una pregunta por mensaje".
Esa regla existe porque un "no" a dos preguntas no dice a cuál contestó; acá los kilos
y los metros no se confunden, así que no hay ambigüedad posible y ahorra un turno.

**El porqué que se le dice** es verdadero y sin juicio: el equipo médico los necesita
para planear el procedimiento y la anestesia con seguridad. **No** se le dice "para ver
si califica", porque hoy no se está decidiendo nada con eso.

---

## 3. Qué se modificó en el código

| dónde | qué |
|---|---|
| `classifyEscalationWithHaiku()` | extrae `peso_kg` y `estatura_cm` **solo si la paciente los dijo**; ante un rango o un aproximado, `null` |
| `numeroEnRango()`, `calcularIMC()` (nuevas) | descartan lecturas imposibles y calculan el IMC redondeado |
| `upsertConversation()` | guarda `imc_orientativo`, **pegajoso** como el tamizaje: solo puede mejorar |
| `PREGUNTA_DE_MEDIDAS`, `PREGUNTAS_CLINICAS` (nuevas) | la pregunta nueva entra en las dos redes que ya existen |
| la tercera cola | reconoce la pregunta nueva: una paciente que se calla después de ella no se muere sola |
| la excepción al atajo del clasificador | también: su respuesta queda guardada aunque la conversación no escale |
| el tope de mensajes | **las preguntas clínicas no lo consumen**, con techo de +4 |

**El peso y la estatura crudos no se guardan.** Se usan en memoria para calcular el
IMC y se descartan.

**El tope**, medido: de las pacientes que llegan a contestar el screening, el 15,8%
toca el tope hoy; con preguntas nuevas y el tope intacto habrían sido muchas más,
cerrando con el motivo `límite de mensajes alcanzado`, que el dashboard cuenta como
falla del sistema. No se toca `message_count` —lo leen otras pantallas— sino el techo.

---

## 4. Pruebas

`wrangler deploy --dry-run`: compila, 193,01 KiB.

**20 pruebas sobre el código real**, extraído del fuente, con `node` y sin
dependencias:

- **El IMC**: 70 kg y 160 cm → 27,3; 95 y 160 → 37,1; falta una medida → sin IMC.
- **Las lecturas imposibles**: una estatura en metros (1.6), un precio leído como peso
  (65000) y una edad leída como peso (26) se descartan; 72 kg se acepta.
- **Las redes**: reconocen "¿cuánto pesa y cuánto mide?" y "su peso y su estatura",
  siguen reconociendo el screening —incluida la del peso activo, que estaba rota— y no
  se disparan con un mensaje que no pregunta nada ni con una pregunta a mitad de
  mensaje.
- **El tope**: 10 sin preguntas, 13 con tres, y se corta en 14 con nueve.

Lo que **no** se puede probar sintéticamente es si la pregunta espanta pacientes. Eso
se mide leyendo conversaciones dentro de dos semanas.

---

## 5. Cómo se pone en producción, en cuatro pasos reversibles

Cada paso es inocuo por sí solo; el flujo recién existe en el cuarto.

1. **Desplegar el Worker.** Con el interruptor apagado no cambia nada.
2. **Aplicar el bloque al prompt** (preparado en `.sofia/prompt.md`). Queda inerte
   mientras no haya un bloque `CRITERIOS APROBADOS`.
3. **Cargar la lista y los criterios** en `sofia_config`, con el interruptor todavía
   apagado.
4. **Encender el interruptor.** Acá empieza a preguntar.

Entre el 3 y el 4 conviene mirar que nada haya cambiado. Y para apagarlo, el paso 4 al
revés: un `update` y listo, sin desplegar.

---

## 6. Lo que sigue pendiente del cirujano

Esto es lo que convierte la medición en un criterio, y hasta que no llegue, en la
columna queda escrito `PENDIENTE_APROBACION_MEDICA`:

1. **¿Qué pasa con una paciente de IMC 30 o más?** ¿Se agenda igual y el médico decide
   en la cita, con el caso avisado? ¿O no se agenda hasta que baje?
2. **¿Hay un segundo umbral?** No es lo mismo 31 que 42.
3. **¿Aplica a todas las cirugías o a algunas?**
4. **¿Qué se le dice a ella?** Es texto que va a leer una paciente y lo aprueba un
   médico.
