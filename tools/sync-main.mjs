#!/usr/bin/env node
/**
 * Chrome no inyecta dos veces el mismo archivo desde distintas entradas de content_scripts (mundos MAIN y
 * aislado): por eso el script de página usa una copia idéntica del matcher. Ejecuta esto tras editar matcher.js.
 */
import { copyFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const src = join(dirname(fileURLToPath(import.meta.url)), '..', 'extension', 'src');
await copyFile(join(src, 'matcher.js'), join(src, 'matcher.main.js'));
console.log('matcher.main.js actualizado');
