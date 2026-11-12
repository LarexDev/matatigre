# Política de privacidad

**Resumen:** MATATIGRE V.1 funciona en tu navegador. No tiene servidores propios, no recopila datos y no incluye analítica ni
telemetría. Lo único que hace en red es **descargar listas de cuentas** de un repositorio público (por defecto, en GitHub), y solo
si te suscribes a alguna. No envía a nadie ni tu configuración, ni tu actividad, ni el contenido de tu timeline.

## Qué guarda

Todo se almacena en `chrome.storage.local`, en tu equipo:

- tus listas propias y las cuentas (handles, nombres y notas) que tú añades o importas, tus reglas, las excepciones («Siempre mostrar») y tus ajustes (incluida la apariencia);
- tus **suscripciones** a listas (id, nombre y URL) y la **última copia descargada** de cada una (handles y, a veces, nombres visibles), más la fecha de la última comprobación y los errores que hubo;
- una copia del catálogo de listas, para mostrarlo sin conexión;
- las cuentas de listas que apagaste para ti;
- estadísticas de filtrado (contadores por motivo, por día y por cuenta);
- si activas el registro local, las cuentas y publicaciones observadas (ver más abajo);
- una copia compacta de la configuración (incluidas las cuentas de las listas que están encendidas) en el almacenamiento local de `x.com`
  (clave `matatigre.cfg`), necesaria para que el filtro funcione desde la primera petición de la página.

Por defecto no guarda el contenido de tu timeline, ni tus mensajes, ni credenciales, ni tu identidad. La única excepción es el **registro local**, que es opcional y está apagado (ver abajo).

## Registro local (opcional, apagado por defecto)

Si activas el *modo analista* en *Opciones → Ajustes*, la extensión guarda **en tu navegador** (IndexedDB) un registro de **lo que toca a las cuentas de tus listas**, para poder analizarlo después:

- lo que **publican o repostean** las cuentas de tus listas, y lo que **otras cuentas les responden, citan, repostean o mencionan** (incluidas las publicaciones originales a las que se refieren). **Nada más**: las cuentas que no tocan a tus listas no se registran. Se registra también lo que el modo *Ocultar* te esconde;
- de cada publicación: identificador, hora, tipo (publicación, repost, cita o respuesta), autor, contadores públicos, enlaces, hashtags, menciones, el motivo por el que se registró y el texto en forma normalizada;
- de las cuentas implicadas: identificador, nombre de usuario (con su historial), nombre visible, biografía y las cifras públicas que X muestra (seguidores, siguiendo, publicaciones), y cuándo se vieron.

El texto se conserva el número de días que indiques (14 por defecto) y después solo queda una huella (SHA-256) que permite reconocer textos repetidos sin guardarlos. Lo visto hace más de 180 días se borra, y hay un tope de 200 000 publicaciones.
No se hace ninguna petición a X ni a nadie para completarlo: solo se guarda lo que tu navegador ya recibió. **Nada de esto sale de tu equipo.**
Puedes borrarlo en cualquier momento con *Opciones → Copia y datos → Borrar registro*; al desinstalar la extensión también se elimina.
Además, la extensión guarda el identificador de usuario de las cuentas de tus listas (clave `uids`) para reconocerlas aunque cambien de nombre, y, si los defines, los **temas** del análisis (clave `topics`: un nombre y unas palabras, sin más) y cuándo hiciste tu última copia de seguridad.
Las librerías de gráficos del análisis (Cytoscape.js y Apache ECharts) van **dentro de la extensión**: no se carga ni se envía nada a internet.

## Análisis y expedientes

Con el registro activo, las cuentas externas que interactúan a menudo con tus listas (3 o más respuestas, citas o reposts directos) pasan a **vigilarse**: se registra también lo que publican, para estudiar cómo se relacionan. Es el mismo tipo de dato público que ya recibe tu navegador; se guarda solo en tu equipo, se recalcula desde el registro (si dejan de interactuar caducan con él) y se puede apagar en *Ajustes → Registro local*. *Borrar registro* también vacía esa lista.

El análisis se ejecuta **en tu navegador** sobre el registro local (un Worker que no hace peticiones de red). Los **expedientes** guardan, para cada observación anclada, su identificador, la hora, la huella del texto, los enlaces, los hashtags y los contadores, y solo guardan un extracto del texto si lo pides al anclar. Lo anclado se conserva aunque el registro purgue lo demás, hasta que borres el expediente.
Los informes y paquetes salen solo cuando pulsas *Informe* o *Exportar paquete*; por defecto las cuentas van seudonimizadas, y los nombres de usuario solo se incluyen si lo marcas. Aun así, los identificadores de publicación permiten localizar a sus autores: trata un paquete como información sobre personas.

## Qué conexiones de red hace

| Cuándo | A dónde | Qué se envía |
| --- | --- | --- |
| Al abrir la pantalla de bienvenida o *Opciones → Listas → Más listas* | Al catálogo: `raw.githubusercontent.com/LarexDev/matatigre-listas` | Una petición `GET` de un archivo público |
| Al suscribirte, y luego al abrir el navegador y cada 12 horas mientras tengas suscripciones | A cada lista suscrita (en el mismo repositorio) | Una petición `GET` por lista |
| Si añades una lista **por URL** | Al servidor que tú indiques | Una petición `GET` por esa URL, con la misma frecuencia |

Las peticiones van **sin cookies, sin cabecera de referencia y sin ningún dato tuyo ni de tu configuración**. Como en cualquier visita
web, el servidor que aloja el archivo (GitHub, o el de la lista por URL) ve tu **dirección IP** y datos técnicos habituales del navegador, y puede
ver que la petición la hace esta extensión; su tratamiento se rige por su propia política (para GitHub, la de GitHub). Si no te suscribes a ninguna lista, tras la bienvenida no se hace
ninguna petición. Aparte de esto, la extensión solo observa las peticiones que la propia página de X ya hace.

Las listas son **datos** (JSON): no contienen código ni se ejecutan, y se validan antes de guardarse.

## Qué NO hace

- No envía datos a su autor ni a terceros (más allá de las descargas de listas descritas arriba).
- No usa cookies, identificadores ni analítica.
- No lee ni modifica páginas distintas de `x.com` y `twitter.com`.

## Permisos

| Permiso | Para qué |
| --- | --- |
| `storage` | Guardar tu configuración, las listas y las estadísticas en tu navegador. |
| `alarms` | Comprobar las listas suscritas cada 12 horas. |
| `contextMenus` | El menú de clic derecho «MATATIGRE» sobre enlaces a cuentas de X. |
| Acceso a `x.com` y `twitter.com` | Ejecutar el filtro en esas páginas y que el popup reconozca la pestaña de X. |

No se piden permisos de acceso a otros sitios: las descargas de listas funcionan porque el servidor permite la lectura pública.

## Limitaciones de privacidad que debes conocer

El filtro en origen debe ejecutarse **en el contexto de la página de X** (necesita interceptar sus respuestas). Por
eso, la configuración compacta —incluida la lista de cuentas que filtras— se comparte con ese script mediante eventos del
documento y `localStorage` de `x.com`. En la práctica, **el JavaScript propio de X podría, si quisiera, observarlos**.
Si esto es un problema para ti, no uses listas que no quieras que X pueda inferir, o no uses la extensión.

La extensión no puede garantizar que X no detecte su presencia ni que no actúe sobre ello. Consulta
el [descargo de responsabilidad](DISCLAIMER.md).

## Tus datos, tu control

- **Exportar** (Opciones → Copia y datos): descarga tu configuración en JSON (sin el contenido de las listas descargadas).
- **Dejar de seguir** una lista (Opciones → Listas) borra su copia local y deja de comprobarla.
- **Borrar el registro local:** *Opciones → Copia y datos → Borrar registro*.
- **Borrar todo:** *Restablecer* en Opciones, o desinstalar la extensión (se borra `chrome.storage.local`). Para borrar
  también la copia en x.com: `F12` → *Application* → *Local storage* → `https://x.com` → elimina `matatigre.cfg`.
- Si compartes un archivo exportado o una lista, ese archivo contiene los datos que tú hayas añadido (handles, notas…):
  eres responsable de lo que compartas.

## Cambios

Los cambios de esta política se anotarán en el [CHANGELOG](CHANGELOG.md). La versión 2.0 añadió las descargas de listas descritas arriba.
