<p align="center">
  <img src="extension/icons/logo.svg" alt="MATATIGRE: un tigre haciendo la venia, con el símbolo de prohibido encima" width="168">
</p>

<h1 align="center">MATATIGRE V.1</h1>

<p align="center">
  <strong>Lo que no quieres ver en X, bloqueado.</strong><br>
  Extensión de Chrome que quita de tu timeline las publicaciones, reposts y citas de las cuentas que tú elijas.
</p>

<p align="center">
  <a href="LICENSE"><img alt="Licencia MIT" src="https://img.shields.io/badge/licencia-MIT-2ea44f"></a>
  <img alt="Manifest V3" src="https://img.shields.io/badge/Chrome-Manifest%20V3-1d9bf0">
  <img alt="Versión 1.0.0" src="https://img.shields.io/badge/versi%C3%B3n-1.0.0-f08a24">
  <img alt="Sin telemetría" src="https://img.shields.io/badge/telemetr%C3%ADa-ninguna-6e7681">
  <img alt="Sin dependencias" src="https://img.shields.io/badge/dependencias-0-6e7681">
</p>

<p align="center">
  <a href="#instalación">Instalación</a> ·
  <a href="#primeros-pasos">Primeros pasos</a> ·
  <a href="#qué-puedes-configurar">Configuración</a> ·
  <a href="#cómo-funciona">Cómo funciona</a> ·
  <a href="docs/USO.md">Manual</a> ·
  <a href="DISCLAIMER.md">Descargo de responsabilidad</a>
</p>

<p align="center">
  <img src="docs/img/modos.png" alt="Comparativa: sin filtro, ocultar, colapsar y resaltar" width="900">
</p>

> **Uso bajo tu propia responsabilidad.** Proyecto independiente, **no afiliado a X Corp.** Lee el
> [descargo de responsabilidad](DISCLAIMER.md) antes de instalar.

## ¿Qué es?

MATATIGRE filtra **lo que tu navegador muestra** de X. Tú eliges qué cuentas no quieres ver y la extensión se encarga del resto:

- 🧹 **Quita** sus publicaciones, los reposts que hacen y las citas a sus posts (y, si lo activas, respuestas y menciones).
- ⚡ **Antes de que se pinten:** intercepta las respuestas de X y elimina las coincidentes; sin parpadeo ni huecos.
- 🎛️ **A tu medida:** tres modos, reglas por nombre, biografía, texto o idioma, listas, excepciones y estadísticas.
- 🔒 **Local:** sin servidores, sin telemetría, sin dependencias. Todo vive en tu navegador.
- 📋 **Con lista inicial:** trae una lista pública y editable de unas 20 cuentas ([ver detalles](docs/LISTAS.md)); la puedes cambiar por completo.

## Instalación

Necesitas **Google Chrome 111 o superior** (también funciona en Edge, Brave y otros navegadores Chromium).
La extensión se instala como *extensión sin empaquetar*; tarda menos de un minuto.

**1 · Descarga y descomprime.** En [**Releases**](https://github.com/LarexDev/matatigre/releases) baja `matatigre-v1.0.0.zip` y
descomprímelo en una carpeta **permanente** (por ejemplo `Documentos\matatigre`): Chrome la usa desde ahí.
*(Si prefieres el código fuente: `git clone https://github.com/LarexDev/matatigre.git` y usa la carpeta `extension`.)*

**2 · Activa el modo de desarrollador.** Abre `chrome://extensions` y activa el interruptor de arriba a la derecha.

<p align="center"><img src="docs/img/instalar-1-modo-desarrollador.png" alt="Paso 1: activar Modo de desarrollador en chrome://extensions" width="860"></p>

**3 · Carga la extensión.** Pulsa **Cargar extensión sin empaquetar** (en inglés *Load unpacked*) y elige la carpeta que contiene `manifest.json`.

<p align="center"><img src="docs/img/instalar-2-cargar-sin-empaquetar.png" alt="Paso 2: botón Cargar extensión sin empaquetar" width="860"></p>

**4 · Comprueba que aparece** la tarjeta *MATATIGRE V.1* y que está activada.

<p align="center"><img src="docs/img/instalar-3-extension-instalada.png" alt="Paso 3: la extensión instalada en chrome://extensions" width="860"></p>

**5 · Abre [x.com](https://x.com) y recarga con `F5`.** Fija la extensión con el icono del puzzle de Chrome → alfiler.

Guía completa (actualizar, desinstalar, solución de problemas): [docs/INSTALACION.md](docs/INSTALACION.md).

## Primeros pasos

<img align="right" src="docs/img/popup.png" alt="El popup de MATATIGRE" width="300">

1. Pulsa el icono del tigre. Debe decir **"Lectura de la API de X activa"** en cuanto X cargue contenido.
2. **Añade una cuenta:** escribe `@usuario` (o pega la URL de su perfil) y pulsa *Añadir*. También puedes abrir el perfil y pulsar *Añadir @usuario (perfil abierto)*.
3. Vuelve a tu Inicio: sus publicaciones dejan de aparecer.
4. Elige el **modo** (ocultar, colapsar o resaltar) y qué más debe contar: citas, reposts, respuestas, menciones.
5. Revisa *Ocultadas recientemente* para detectar falsos positivos.
6. **Gestionar lista y reglas…** abre la página de opciones.

> La lista inicial se elaboró de forma automática a partir de información pública y **puede contener errores**: revísala en *Opciones → Cuentas*.
> Si eres titular de una cuenta incluida y quieres que se corrija o se retire, abre un [issue](https://github.com/LarexDev/matatigre/issues/new/choose).

<br clear="right">

## Qué puedes configurar

<p align="center"><img src="docs/img/opciones-cuentas.png" alt="Opciones: cuentas" width="780"></p>

| Qué | Opciones |
| --- | --- |
| **Modo** | *Ocultar* (se quita antes de pintarse) · *Colapsar* (barra con el motivo; clic para ver) · *Resaltar* (visible pero marcada). |
| **Qué cuenta** | Autor (siempre) · reposts de una cuenta de tu lista · **citas** a una cuenta de tu lista · respuestas dirigidas a ella · menciones de ella · sugerencias de personas. |
| **Reglas** | Sobre **usuario**, **nombre**, **biografía**, **texto** e **idioma**, con comodín (`bot_*`), "contiene" o expresión regular. Incluye un probador. |
| **Dónde** | Un interruptor por sección: Inicio, Búsqueda, Perfiles, Publicación abierta e hilos, Listas, Notificaciones, Guardados, Otras. |
| **Excepciones** | Lista blanca (nunca se oculta) · no filtrar el perfil de la propia cuenta · no ocultar la publicación que abres directamente. |
| **Listas** | Agrupa cuentas con etiquetas y enciende o apaga cada grupo entero. |
| **Estadísticas** | Total, por motivo, por día y cuentas más filtradas. |
| **Copia de seguridad** | Exportar e importar (con validación) en JSON. |
| **Atajos** | `Alt+Shift+M` pausa o reanuda · `Alt+Shift+H` alterna ocultar/resaltar (reasignables en `chrome://extensions/shortcuts`). |

<details>
<summary><strong>Ver más capturas</strong> (reglas, ajustes y estadísticas)</summary>

<p align="center"><img src="docs/img/opciones-reglas.png" alt="Opciones: reglas" width="780"></p>
<p align="center"><img src="docs/img/opciones-ajustes.png" alt="Opciones: ajustes" width="780"></p>
<p align="center"><img src="docs/img/opciones-estadisticas.png" alt="Opciones: estadísticas" width="780"></p>

</details>

Por defecto se filtran autor, reposts y citas; respuestas y menciones quedan apagadas para no ocultar de más.
Manual detallado: [docs/USO.md](docs/USO.md). Las capturas usan cuentas ficticias.

## Cómo funciona

X cambia su interfaz con frecuencia (su DOM actual ni siquiera tiene `data-testid`). MATATIGRE usa dos capas independientes:

1. **Filtro en origen.** Un script intercepta las respuestas de la API que X usa para pintar el timeline, identifica autor,
   repost, cita, respuesta y menciones de cada publicación y **elimina las coincidentes de la respuesta** antes de que lleguen a la pantalla.
2. **Respaldo en el DOM.** Lee cada publicación por sus enlaces (`/usuario/status/ID`) y aplica ocultar, colapsar o resaltar.

Arquitectura y detalles técnicos: [docs/DESARROLLO.md](docs/DESARROLLO.md).

## Limitaciones

- **X puede cambiar su sitio o su API en cualquier momento** y romper parcial o totalmente la extensión. Si algo se cuela:
  popup → **Copiar diagnóstico** y abre un [issue](https://github.com/LarexDev/matatigre/issues/new/choose).
- Los cambios de configuración afectan a lo que X cargue **desde ese momento**; recarga la pestaña para aplicarlos a todo.
- Una lista de usuarios no sigue a las personas: si una cuenta cambia de nombre de usuario, deja de coincidir.
- No filtra mensajes directos ni contenido que sea solo imagen. No silencia ni bloquea en X: solo filtra lo que ve tu navegador.
- Las reglas de texto, nombre y biografía pueden ocultar de más (falsos positivos); pruébalas con el probador antes.
- Verificada con una batería automática y con la estructura de X observada sin sesión; el comportamiento exacto con sesión puede variar.

## Documentación

| Documento | Contenido |
| --- | --- |
| [docs/INSTALACION.md](docs/INSTALACION.md) | Instalación paso a paso, actualización, desinstalación, solución de problemas |
| [docs/USO.md](docs/USO.md) | Manual de uso |
| [docs/LISTAS.md](docs/LISTAS.md) | Lista inicial y formato de listas e importación |
| [docs/DESARROLLO.md](docs/DESARROLLO.md) | Arquitectura, pruebas, empaquetado y publicación |
| [PRIVACY.md](PRIVACY.md) | Qué datos guarda la extensión y qué permisos usa |
| [DISCLAIMER.md](DISCLAIMER.md) | Descargo de responsabilidad |
| [CHANGELOG.md](CHANGELOG.md) | Historial de versiones |
| [CONTRIBUTING.md](CONTRIBUTING.md) · [SECURITY.md](SECURITY.md) | Contribuir y reportar vulnerabilidades |

## Aviso legal

Este software se ofrece **"tal cual", sin garantía de ningún tipo**. El autor **no se hace responsable** del uso que
se le dé ni de sus consecuencias (incluidas posibles restricciones de tu cuenta por parte de X, contenido que no se
oculte o se oculte por error, o cualquier daño derivado). El uso es **exclusivamente bajo tu propia responsabilidad**.
Texto completo en [DISCLAIMER.md](DISCLAIMER.md). Licencia: [MIT](LICENSE).

"X" y "Twitter" son marcas de sus respectivos titulares. Este proyecto es independiente y no está afiliado, patrocinado
ni respaldado por X Corp.
