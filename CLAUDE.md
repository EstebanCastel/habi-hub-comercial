@AGENTS.md

# Flujo de trabajo

**Nunca trabajar directamente en `main`.** Todo cambio va en la rama `juancampos`.

## Pasos

1. Asegúrate de estar en la rama `juancampos`:
   ```bash
   git checkout juancampos
   git pull origin juancampos
   ```
2. Haz tus cambios y commits normalmente.
3. Haz push a `juancampos`:
   ```bash
   git push origin juancampos
   ```
4. Abre un Pull Request de `juancampos` → `main` en GitHub.
5. Espera el **approve de EstebanCastel** — sin su aprobación el PR no puede hacer merge.
6. Una vez aprobado y mergeado, Vercel despliega automáticamente.

## Reglas de la rama `main`

- `main` tiene **branch protection**: requiere 1 review aprobatorio antes de merge.
- Solo EstebanCastel puede aprobar PRs a `main`.
- No hacer push directo a `main` ni bypasear el PR.
