# Librerías incluidas

Van dentro de la extensión (no se descarga nada de internet al usarla) y solo las usa la pestaña *Análisis* de las opciones.
Cada archivo conserva su cabecera de licencia; el texto completo está en los archivos `LICENSE-*` y `NOTICE-*` de esta carpeta.

| Archivo | Librería | Versión | Licencia | SHA-256 |
| --- | --- | --- | --- | --- |
| `cytoscape.min.js` | [Cytoscape.js](https://js.cytoscape.org/) (mapa de relaciones) | 3.34.4 | MIT | `081591ab735b2b6a3b31a3c60f8f3a3e2fee8c92939e0c7820ad1208571b6cd8` |
| `echarts.common.min.js` | [Apache ECharts](https://echarts.apache.org/) (curvas y gráficos) | 6.1.0 | Apache-2.0 | `61f13280aba3161f77fc801bf5f9c786f55f10432153a0683fc5cc0700b013d5` |

Son los archivos `dist/` de los paquetes de npm con esas versiones, sin modificar. Ninguna usa `eval` ni `new Function`, así que funcionan con la
política de seguridad de contenido de las extensiones (`script-src 'self'`).

**Actualizarlas:** descargar el paquete (`npm pack cytoscape@<versión>`, `npm pack echarts@<versión>`), copiar el archivo de `dist/` y los `LICENSE`/`NOTICE`,
actualizar esta tabla con la versión y el hash (`sha256sum`) y pasar las pruebas (`npm test`, `npm run test:e2e`). Conviene elegir versiones con al menos unas semanas de antigüedad.
