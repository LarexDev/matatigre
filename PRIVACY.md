# Política de privacidad

**Resumen:** MATATIGRE V.1 funciona íntegramente en tu navegador. No tiene servidores, no recopila datos, no envía
nada a ningún sitio y no incluye analítica ni telemetría.

## Qué guarda

Todo se almacena en `chrome.storage.local`, en tu equipo:

- la lista inicial incluida en la extensión (nombres de usuario públicos y etiquetas) y las cuentas (handles, nombres, etiquetas y notas) que tú añades o importas;
- tus reglas, la lista blanca y tus ajustes;
- estadísticas de filtrado (contadores por motivo, por día y por cuenta);
- una copia compacta de la configuración en el almacenamiento local de `x.com` (clave `matatigre.cfg`), necesaria para
  que el filtro funcione desde la primera petición de la página.

No guarda el contenido de tu timeline, ni tus mensajes, ni credenciales, ni tu identidad.

## Qué NO hace

- No realiza peticiones de red propias: solo observa las que la propia página de X ya hace.
- No envía datos a su autor ni a terceros.
- No usa cookies, identificadores ni analítica.
- No lee ni modifica páginas distintas de `x.com` y `twitter.com`.

## Permisos

| Permiso | Para qué |
| --- | --- |
| `storage` | Guardar tu configuración y estadísticas en tu navegador. |
| Acceso a `x.com` y `twitter.com` | Ejecutar el filtro en esas páginas y que el popup reconozca la pestaña de X. |

## Limitaciones de privacidad que debes conocer

El filtro en origen debe ejecutarse **en el contexto de la página de X** (necesita interceptar sus respuestas). Por
eso, la configuración compacta —incluida la lista de cuentas que filtras— se comparte con ese script mediante eventos del
documento y `localStorage` de `x.com`. En la práctica, **el JavaScript propio de X podría, si quisiera, observarlos**.
Si esto es un problema para ti, no uses listas que no quieras que X pueda inferir, o no uses la extensión.

La extensión no puede garantizar que X no detecte su presencia ni que no actúe sobre ello. Consulta
el [descargo de responsabilidad](DISCLAIMER.md).

## Tus datos, tu control

- **Exportar** (Opciones → Datos): descarga tu configuración en JSON.
- **Borrar:** *Restablecer* en Opciones, o desinstalar la extensión (se borra `chrome.storage.local`). Para borrar
  también la copia en x.com: `F12` → *Application* → *Local storage* → `https://x.com` → elimina `matatigre.cfg`.
- Si compartes un archivo exportado o una lista, ese archivo contiene los datos que tú hayas añadido (handles, notas…):
  eres responsable de lo que compartas.

## Cambios

Los cambios de esta política se anotarán en el [CHANGELOG](CHANGELOG.md).
