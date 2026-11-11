# Fase 2 — el interruptor, la lista y los criterios

Fecha: 2026-11-11. Rama `feat/preclasificacion-interruptor`. **No desplegado.**
Producción sigue en `3b31293`.

Esta fase **no cambia una palabra de lo que Sofía dice**. Deja puesto el interruptor y
el lugar donde van a vivir los criterios, para que la fase 3 se pueda encender y apagar
sin desplegar.

---

## 1. Qué se agregó

Tres columnas en `sofia_config` (el SQL está en [`03`](03-propuesta-sql.md)) y el
código que las lee:

| columna | para qué | nace |
|---|---|---|
| `preclasificacion_enabled` | el interruptor | `false` |
| `preclasificacion_procedimientos` | para qué cirugías aplica | `{}` |
| `preclasificacion_criterios` | el texto de los cirujanos | vacío |

Y una función, `bloqueDeCriterios()`, que arma el texto que se le pega al prompt — o
devuelve `null`, que hoy es siempre.

---

## 2. Las dos decisiones que importan

### 2.1 Los criterios van pegados al prompt, no en un bloque propio

La API de Anthropic acepta **cuatro** bloques con `cache_control` y en la rama del RAG
ya se usan tres: prompt, catálogo de tratamientos y promociones. Un bloque nuevo
gastaría el cuarto y último.

Pegados al prompt, el costo es **una reescritura de caché el día que los cirujanos
cambien un criterio** — pasa pocas veces al mes y el TTL es de una hora. Un bloque
nuevo habría sido un costo permanente.

### 2.2 Dos intentos al leer la configuración, y no es paranoia

Esto es lo más importante de la entrega y no estaba en el diseño.

Si las columnas nuevas **todavía no existen** en la base, PostgREST no devuelve esas
columnas vacías: **rechaza el SELECT entero con un 400**. Y el camino de error de
`loadSofiaConfig()` devuelve `system: ""`, o sea que **Sofía seguiría contestándole a
todas las pacientes sin prompt**. Es el peor desenlace posible de todo este trabajo, y
se habría disparado con solo desplegar antes de correr el SQL.

Ahora hay un segundo intento sin esas columnas. Consecuencias:

- **El orden entre la migración y el despliegue deja de importar.** Conviene correr el
  SQL primero igual, pero ya no es un riesgo: es un request de más por mensaje mientras
  la migración no esté corrida.
- Si la base entera no responde, se devuelve el estado seguro y el flujo queda apagado.

---

## 3. Qué se modificó

Un solo archivo, `src/index.js`:

| dónde | qué |
|---|---|
| `loadSofiaConfig()` | lee las tres columnas, con el segundo intento de 2.2 y valores por defecto en "apagado" |
| `bloqueDeCriterios()` (nueva) | arma el bloque, o `null` si el flujo no debe existir |
| `buildSystemBlocks()` | recibe los criterios y los pega al bloque del prompt |
| el llamador | le pasa `bloqueDeCriterios(sofiaConfig)` |

**Nada más.** Ni el tamizaje, ni las etiquetas, ni las colas, ni el traspaso, ni el
clasificador, ni el RAG, ni el tope.

---

## 4. Pruebas

`npx wrangler deploy --dry-run`: compila, 190,51 KiB (50,28 KiB comprimido).

Y **12 pruebas sobre el código real** — extraído del fuente, no reescrito — con `node`
y sin dependencias nuevas:

**El freno del código (`bloqueDeCriterios`):**

| caso | resultado |
|---|---|
| interruptor apagado, con criterios cargados | no se inyecta nada ✓ |
| encendido con la lista vacía ← **como nace** | nada ✓ |
| lista con strings vacíos | nada ✓ |
| lista cargada y criterios vacíos | nada, y deja `PRECLASIFICACION_SIN_CRITERIOS` ✓ |
| configuración sin las columnas | nada ✓ |
| todo cargado | se inyecta, empieza por `CRITERIOS APROBADOS` y nombra los procedimientos ✓ |

**El freno de la lectura (`loadSofiaConfig` con las columnas inexistentes):**

| caso | resultado |
|---|---|
| reintenta sin las columnas nuevas | ✓ |
| **no se queda sin prompt** | ✓ |
| sigue leyendo la base de conocimiento | ✓ |
| el flujo queda apagado | ✓ |
| y entonces no se inyecta nada | ✓ |
| si la base entera falla, estado seguro | ✓ |

---

## 5. Cómo se pone en producción

1. **Correr el SQL** de la sección 1 de [`03-propuesta-sql.md`](03-propuesta-sql.md)
   (tres `alter table` sobre `sofia_config`, que tiene una sola fila).
2. Comprobar con un `select` que las tres columnas existen y que
   `preclasificacion_enabled` quedó en `false`.
3. Desplegar el Worker.
4. **Comprobar que nada cambió**: Sofía tiene que comportarse igual. Con el interruptor
   apagado y la lista vacía, no hay un solo byte distinto en lo que recibe Claude.

El paso 4 es la prueba de que esta fase está bien hecha: si se nota algo, está mal.

---

## 6. Cómo apagarlo

`update sofia_config set preclasificacion_enabled = false;` — efecto en el mensaje
siguiente, sin desplegar nada.

Y si hay que revertir el código: `git revert` del commit y desplegar. La reversión del
SQL está en la sección 4 de `03`, pero **no hace falta tocarla**: con el interruptor
apagado las columnas no se leen para nada.

---

## 7. Lo que falta para que esto haga algo

Las dos cosas de siempre, y en este orden:

1. **Los criterios de los cirujanos**, con la hoja de
   [`07`](07-hoja-de-criterios.md).
2. **La fase 3**: el bloque de conducta en el prompt ([`04`](04-prompt-propuesto.md)),
   las preguntas, el permiso y la clasificación. Y antes de empezarla, el arreglo de
   pasado/presente de [`06`](06-arreglo-peso-pasado.md), que ya está aplicado.
