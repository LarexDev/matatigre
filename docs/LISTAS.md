# Listas e importación

Este documento cubre las **listas suscribibles** (cómo funcionan y cómo publicar una) y el **formato de importación y exportación** de tu configuración.

## Importar y exportar

La extensión importa y exporta **JSON**. Importar **suma** a tu configuración actual (no la borra); consulta el
[manual de uso](USO.md#datos). Todos los campos son opcionales; lo que falte o no sea válido se ignora.

Hay un ejemplo completo en [`examples/lista-ejemplo.json`](../examples/lista-ejemplo.json).

> **Responsabilidad:** las listas que importes son decisión tuya. No importes listas de procedencia dudosa ni uses
> listas para acosar o perjudicar a nadie. Lee el [descargo de responsabilidad](../DISCLAIMER.md).

## Estructura

```json
{
  "accounts": [
    { "handle": "ejemplo_uno", "name": "Ejemplo uno", "tags": ["mi-lista"], "note": "Texto libre", "enabled": true },
    { "handle": "ejemplo_dos", "tags": ["mi-lista", "ruido"] }
  ],
  "lists": { "mi-lista": true, "ruido": false },
  "rules": [
    { "kind": "handle", "mode": "glob", "pattern": "bot_*", "note": "opcional", "enabled": true }
  ],
  "allowlist": ["mi_amigo"],
  "settings": { "mode": "hide", "filterQuoted": true }
}
```

### `accounts`
Lista de objetos (o un mapa de objetos). Cada cuenta:

| Campo | Tipo | Notas |
| --- | --- | --- |
| `handle` | texto | **Obligatorio.** Sin `@`, 1 a 15 letras, números o `_`. Es la clave: si ya existe, se actualiza. |
| `name` | texto | Opcional, máx. 120 caracteres. |
| `tags` | lista de textos | Opcional. Cada etiqueta forma una *lista*. Se normalizan a minúsculas con guiones. |
| `note` | texto | Opcional, máx. 500 caracteres. |
| `enabled` | booleano | `false` para guardarla desactivada. Por defecto `true`. |

### `myLists`
Mapa `id → { name, created }` con tus **listas propias**. Las etiquetas de `accounts[].tags` que no estén aquí se crean como listas propias al importar. Desde *Opciones → Listas* también puedes **exportar una lista propia** como archivo de lista (el mismo formato de las listas sincronizadas, ver abajo).

### `lists`
Mapa `etiqueta → true/false`: enciende o apaga cada lista. Una etiqueta sin entrada aquí se considera **encendida**.

### `rules`
| Campo | Valores |
| --- | --- |
| `kind` | `handle`, `name`, `bio`, `text`, `lang` |
| `mode` | `glob` (comodín `*`), `contains` (sin distinguir mayúsculas ni tildes), `regex` |
| `pattern` | texto del patrón (máx. 300). Los regex inválidos se descartan. |
| `note`, `enabled` | opcionales |

### `allowlist`
Lista de handles que **nunca** se ocultan.

### `disabled` y `subs`
`disabled` es la lista de handles de listas suscritas que apagaste para ti. `subs` son tus suscripciones (`{ "id", "source" }`, y la `url` si es una lista
externa). Al importar un archivo, de `subs` **solo se aceptan ids del catálogo** (`"source": "catalog"`), nunca URLs, y la extensión te pregunta antes de descargarlas.

### `settings`
Cualquiera de: `enabled`, `mode` (`hide` · `collapse` · `highlight`), `deepFilter`, `filterReposters`, `filterQuoted`,
`filterReplies`, `filterMentions`, `filterUserCells`, `pauseOnProfile`, `keepFocal` (booleanos) y `scope` con
`home`, `search`, `profile`, `status`, `list`, `notifications`, `bookmarks`, `other` (booleanos).
Los ajustes importados **reemplazan** los actuales.

## Límites y validación

Máximo 20 000 cuentas, 500 reglas y 20 000 handles en la lista blanca por archivo. Se descartan handles no válidos,
tipos incorrectos, modos desconocidos y expresiones regulares que no compilen. Los archivos exportados por la propia
extensión se pueden volver a importar tal cual.

## Listas suscribibles

Desde la 2.0 la extensión **no incluye cuentas**: te suscribes a listas que viven en un repositorio de datos
([`LarexDev/matatigre-listas`](https://github.com/LarexDev/matatigre-listas)) y se descargan solas.

| Qué | Cómo funciona |
| --- | --- |
| Catálogo | `index.json` del repositorio: qué listas existen y cuáles se recomiendan. La pantalla de bienvenida lo muestra al instalar; después, *Opciones → Listas → Más listas*. |
| Descarga | Una petición `GET` por lista, sin cookies ni datos tuyos. El catálogo se consulta al abrir la bienvenida o *Más listas*; las listas, cuando te suscribes y luego al abrir el navegador y cada 12 horas. Sin suscripciones no se descarga nada. |
| Capas | Cada lista es de **solo lectura** y se reemplaza entera al actualizarse. Encima van tus ajustes: cuentas que apagaste, tus listas y cuentas propias, las excepciones («Siempre mostrar») y los interruptores de cada lista. Si una cuenta sale de una lista, deja de filtrarse para todos. |
| Precedencia | «Siempre mostrar» > cuenta propia desactivada > cuenta propia > listas suscritas. Una cuenta en dos listas se filtra si **alguna** está encendida. |
| Fallos | Si no hay conexión, el servidor falla o el archivo no es válido, se conserva la última copia buena y *Opciones → Listas* muestra el error. |
| Retiradas | Si una lista se retira del catálogo (`withdrawn`), la extensión deja de seguirla y borra su copia. |

### Publicar tu propia lista

Cualquiera puede publicar una lista en una URL **https** (por ejemplo, un archivo en GitHub, usando su enlace «Raw»). El servidor debe
permitir la lectura desde otros orígenes (`Access-Control-Allow-Origin: *`; GitHub y GitHub Pages lo hacen). Quien quiera usarla pega la URL en
*Opciones → Listas → Añadir por URL*. La extensión pide confirmación antes de añadirla.

Formato de un archivo de lista (`schema: 1`):

```json
{
  "schema": 1,
  "id": "mi-lista",
  "name": "Mi lista",
  "description": "Una frase sobre qué agrupa.",
  "version": "2026-11-08.1",
  "updated": "2026-11-08",
  "accounts": [
    { "handle": "ejemplo_uno", "name": "Nombre visible (opcional)" },
    { "handle": "ejemplo_dos" }
  ]
}
```

Cada cuenta puede llevar además un `"id"` (el id numérico de usuario de X): con él la extensión reconoce a la cuenta aunque cambie de nombre de usuario. Es opcional; si falta, la extensión lo aprende sola.

Las reglas completas (límites, catálogo, `withdrawn`) están en el [FORMATO.md del repositorio de listas](https://github.com/LarexDev/matatigre-listas/blob/main/FORMATO.md).
Se descartan duplicados y handles no válidos; se admiten hasta 5 000 cuentas y 2 MB por archivo. Solo se aceptan URLs `https://` (y `http://` hacia tu propia máquina, para desarrollo).

### Seguridad de las suscripciones

- Quien controla una lista controla qué se oculta en tu pantalla. Suscríbete solo a listas de quien conozcas.
- Un archivo de configuración importado **nunca** puede añadir una suscripción por URL: solo ids del catálogo. Las suscripciones por URL se agregan a mano.
- Las listas son datos: no contienen código ni se ejecutan.

## Listas del catálogo

El catálogo actual reúne cinco listas con **205 cuentas públicas** (una cuenta está en dos), solo con nombre de usuario y, cuando se trata de cargos o
figuras públicas, el nombre visible. No llevan notas ni textos de terceros.

| Lista | Qué reúne | Cuentas | En la bienvenida |
| --- | --- | ---: | --- |
| Abelardo y su gobierno | El presidente, su gabinete, funcionarios, círculo cercano y las cuentas de su movimiento | 26 | marcada |
| Abelardistas | Influenciadores y activistas de la red cercana a Abelardo de la Espriella | 21 | marcada |
| Petro y su gobierno | Gustavo Petro, su familia política y quienes fueron ministros o altos funcionarios de su gobierno | 32 | sin marcar |
| Petristas | Pacto Histórico, congresistas afines, influenciadores y simpatizantes del petrismo | 124 | sin marcar |
| Antipetristas | Cuentas identificadas como antipetristas | 2 | sin marcar |

Al seguir una lista queda encendida; las «sin marcar» se añaden desde *Opciones → Listas → Más listas*.

Los handles se comprobaron abriendo cada perfil en X y se apoyan en información pública (cargos oficiales y reportajes de
prensa). Los cargos y los vínculos cambian, y un nombre de usuario puede cambiar de dueño: por eso conviene revisarlas.

Más información en el [descargo de responsabilidad](../DISCLAIMER.md#4-las-listas-son-responsabilidad-tuya).
Revísalas en *Opciones → Listas*; cualquier cuenta de una lista se puede omitir solo para ti. Para pedir la corrección o el retiro de una cuenta,
abre un [issue en el repositorio de listas](https://github.com/LarexDev/matatigre-listas/issues/new/choose).

## Límites

Para que la extensión no se sature: **5 000 cuentas por lista**, **25 000 entre todas las listas sincronizadas** y **30 listas sincronizadas**. Una lista que no cabe se rechaza con un mensaje claro; si una actualización haría superar el total, se conserva la copia anterior. Las cuentas propias admiten hasta 20 000.
Al actualizar, la extensión anota qué cuentas entraron y salieron (se ve en la lista) y avisa si el cambio es grande (25 % o más de la lista).
