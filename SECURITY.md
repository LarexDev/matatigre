# Seguridad

## Reportar una vulnerabilidad

Si encuentras un problema de seguridad (por ejemplo, una forma de que una página o un archivo importado ejecute código,
filtre datos de la configuración o eluda la validación), **no abras un issue público**. Usa el
[reporte privado de vulnerabilidades de GitHub](https://github.com/LarexDev/matatigre/security/advisories/new) de este repositorio.

Incluye los pasos para reproducirlo, la versión y tu navegador. Se atenderá en la medida de lo posible; este es un
proyecto personal sin garantías de plazos (ver [DISCLAIMER.md](DISCLAIMER.md)).

## Versiones con soporte

Solo la última versión publicada.

## Superficie de ataque (resumen)

- Sin servidores ni peticiones de red propias.
- Los archivos importados se **validan y limitan** (`sanitizeConfig`) antes de guardarse; la interfaz muestra los datos con `textContent`, nunca como HTML.
- El script de página se ejecuta en el contexto de X; consulta las limitaciones en [PRIVACY.md](PRIVACY.md).
