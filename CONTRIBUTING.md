# Contribuir

¡Gracias por el interés! Este proyecto es pequeño y busca seguir siéndolo: JavaScript puro, sin dependencias, sin servidores.

## Antes de abrir un issue

- Lee el [manual de uso](docs/USO.md) y la sección de [problemas frecuentes](docs/INSTALACION.md#problemas-frecuentes).
- Si algo no se oculta o se oculta de más, adjunta el **diagnóstico**: popup → *Copiar diagnóstico*. No contiene el
  contenido de tu timeline. Revisa el texto antes de pegarlo.
- No publiques listas de personas ni datos personales en issues o pull requests.

## Pull requests

1. Haz un fork y crea una rama.
2. Instala Node.js 22+. No hay dependencias que instalar.
3. Si tocas `extension/src/matcher.js`, ejecuta `npm run sync` (regenera `matcher.main.js`).
4. Añade o ajusta pruebas: `npm test` y, si cambias el filtrado, `tests/dom-fixture.html` (`npm run serve`) y `npm run test:e2e`.
5. Describe qué cambia y por qué. Mantén el estilo del código (sin dependencias nuevas, comentarios solo cuando aclaran el "por qué").

## Fuera de alcance

- Altas de cuentas en la lista inicial incluida (solo se aceptan **correcciones y retiros**, mediante el issue «Retiro o corrección de una cuenta»).
- Telemetría, cuentas de usuario, servidores o cualquier envío de datos.
- Funciones de acoso, seguimiento o recopilación de información de terceros.

Al contribuir aceptas que tu aportación se publique bajo la [licencia MIT](LICENSE) del proyecto.
