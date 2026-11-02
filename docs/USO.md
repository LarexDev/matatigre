# Manual de uso

Todo lo que se configura se guarda **localmente** en tu navegador. Los cambios se aplican en caliente; lo que X ya
cargó se re-evalúa al instante y lo nuevo se filtra desde que llega.

## El popup (icono del tigre)

![El popup](img/popup.png)

| Elemento | Qué hace |
| --- | --- |
| Interruptor | Activa o pausa todo el filtrado. |
| **Ocultas en esta vista** | Publicaciones filtradas desde que abriste esta sección de X. |
| **Cuentas activas** | Cuántas cuentas están filtrándose ahora (las de listas apagadas o desactivadas no cuentan). |
| Estado de la API | Verde: la extensión lee las respuestas de X (filtro en origen). Naranja: solo funciona el respaldo del DOM; recarga la pestaña. |
| **Modo** | Ocultar · Colapsar · Resaltar (ver abajo). |
| Casillas rápidas | Citas, reposts, respuestas y menciones de cuentas de tu lista. |
| **Añadir** | Añade una cuenta por `@handle` o URL de su perfil. |
| *Añadir @handle (perfil abierto)* | Aparece si estás en el perfil de una cuenta que aún no está en tu lista. |
| Ocultadas recientemente | Últimas cuentas filtradas y por qué (útil para detectar falsos positivos). |
| **Copiar diagnóstico** | Copia un informe técnico para adjuntar a un issue. |

## Modos

![Los tres modos frente al feed original](img/modos.png)

- **Ocultar:** la publicación se **elimina de la respuesta de X** antes de pintarse (y del DOM como respaldo). No quedan huecos. Es el más efectivo.
- **Colapsar:** la publicación se sustituye por una barra con el motivo; un clic la muestra.
- **Resaltar:** se deja visible con una marca roja y el motivo. Sirve para comprobar qué filtraría la extensión.

Atajos: `Alt+Shift+M` pausa o reanuda; `Alt+Shift+H` alterna entre Ocultar y Resaltar. Se reasignan en `chrome://extensions/shortcuts`.

## Página de opciones

Popup → **Gestionar lista y reglas…**

### Cuentas

![Opciones: cuentas](img/opciones-cuentas.png)
Tabla con búsqueda, filtro por lista y por estado. Puedes añadir (handle, nombre y listas opcionales), **editar**,
activar o desactivar con la casilla, **eliminar**, y aplicar acciones en bloque a lo que muestre el filtro actual
(*Activar / Desactivar / Eliminar las visibles*).

### Listas
Cada etiqueta que pongas a una cuenta forma una **lista** que puedes encender o apagar entera. Una cuenta con varias
etiquetas se filtra si **alguna** de ellas está activa. Una cuenta sin etiquetas siempre se filtra.

### Reglas

![Opciones: reglas](img/opciones-reglas.png)
Reglas adicionales a la lista de cuentas. Cada una tiene un **tipo**:

| Aplica a | Ejemplo |
| --- | --- |
| Handle | `bot_*` (comodín) |
| Nombre visible | contiene `sorteo` |
| Biografía | contiene `vendo seguidores` |
| Texto de la publicación | regex `\bgratis\b` |
| Idioma | `ja` |

Y una **coincidencia**: comodín (`*` = cualquier texto), "contiene" (sin distinguir mayúsculas ni tildes) o expresión regular.
Usa el **probador** al final de la pestaña antes de fiarte de una regla. Las reglas de texto, nombre y biografía son
las más propensas a ocultar de más.

### Lista blanca
Cuentas que **nunca** se ocultan, aunque coincidan con la lista, una regla o un repost.

### Ajustes

![Opciones: ajustes](img/opciones-ajustes.png)
- **Modo** y **Filtro en origen** (quitar de la respuesta de X; recomendado).
- **Qué cuenta como coincidencia:** autor (siempre), reposts, citas, respuestas, menciones, sugerencias de personas.
- **Dónde se filtra:** un interruptor por sección de X (Inicio, Búsqueda, Perfiles, Publicación abierta e hilos, Listas, Notificaciones, Guardados, Otras).
- **Excepciones:** no filtrar el perfil de la propia cuenta; no ocultar la publicación que abres directamente.

Valores por defecto: autor, reposts y citas **sí**; respuestas y menciones **no**.

### Estadísticas

![Opciones: estadísticas](img/opciones-estadisticas.png)
Total filtrado, por motivo, por día (últimos 10) y cuentas más filtradas. Se pueden reiniciar.

### Datos
- **Fusionar lista inicial:** añade las cuentas de la lista inicial incluida en la extensión (110 cuentas en cinco listas; no pisa tus ediciones).
- **Exportar:** descarga un JSON con toda tu configuración (copia de seguridad).
- **Importar:** lee un JSON y **suma** sus cuentas, listas, reglas y lista blanca a lo que ya tienes; los ajustes del archivo sí reemplazan los actuales. Los datos se validan antes de guardarse. Formato: [LISTAS.md](LISTAS.md).
- **Restablecer:** borra todo y vuelve al estado inicial.

## Dónde se aplica cada cosa

| Situación | Comportamiento |
| --- | --- |
| Estás en el perfil de una cuenta de tu lista | Se muestran sus publicaciones (opción activa por defecto). Las de otras cuentas de tu lista siguen ocultas. |
| Abres una publicación concreta (`/usuario/status/…`) | Se muestra esa publicación (opción activa por defecto); las demás del hilo se filtran. |
| Una sección está apagada en *Dónde se filtra* | No se filtra nada en esa sección. |
| La cuenta está en la lista blanca | Nunca se oculta. |

## Consejos

- Empieza en modo **Resaltar** para ver qué se filtraría antes de pasar a Ocultar.
- Si algo se oculta por error, mira *Ocultadas recientemente* en el popup y añade la cuenta a la lista blanca.
- Después de cambios grandes, recarga la pestaña de X para que lo nuevo se cargue ya filtrado.
