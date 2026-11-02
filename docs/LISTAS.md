# Formato de listas e importación

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

### `settings`
Cualquiera de: `enabled`, `mode` (`hide` · `collapse` · `highlight`), `deepFilter`, `filterReposters`, `filterQuoted`,
`filterReplies`, `filterMentions`, `filterUserCells`, `pauseOnProfile`, `keepFocal` (booleanos) y `scope` con
`home`, `search`, `profile`, `status`, `list`, `notifications`, `bookmarks`, `other` (booleanos).
Los ajustes importados **reemplazan** los actuales.

## Límites y validación

Máximo 20 000 cuentas, 500 reglas y 20 000 handles en la lista blanca por archivo. Se descartan handles no válidos,
tipos incorrectos, modos desconocidos y expresiones regulares que no compilen. Los archivos exportados por la propia
extensión se pueden volver a importar tal cual.

## Lista inicial incluida en la extensión

`extension/data/accounts.json` es la lista que se carga al instalar: **unas 20 cuentas públicas**, solo con nombre de
usuario, etiquetas y estado (y el nombre visible en pocos casos). No lleva notas ni textos de terceros.

| Lista | Estado por defecto |
| --- | --- |
| Abelardistas | activa |
| Abelardo y su entorno oficial | activa |
| Antipetristas | apagada |
| Petristas | apagada |

Se elaboró de forma automática y heurística: **puede tener errores** (ver el [descargo de responsabilidad](../DISCLAIMER.md#4-la-lista-inicial-y-las-listas-son-responsabilidad-tuya)).
Revísala en *Opciones → Cuentas*; cualquier cuenta se puede desactivar o eliminar, y las listas se apagan enteras en *Opciones → Listas*.
Para pedir la corrección o el retiro de una cuenta, abre un [issue](https://github.com/LarexDev/matatigre/issues/new/choose).

Si quieres una lista propia que se cargue sola al instalar (por ejemplo en tu equipo), guárdala como
`extension/data/accounts.local.json` con el mismo formato (`{ "lists": {...}, "accounts": [...] }`). Ese archivo está en
`.gitignore` y el empaquetado (`npm run build`) lo excluye siempre, así que no se publica por accidente.
