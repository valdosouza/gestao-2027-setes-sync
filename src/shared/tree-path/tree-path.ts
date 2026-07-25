/**
 * Matemática do CAMINHO MATERIALIZADO dos cadastros em ÁRVORE (porta do
 * Delphi Pc_DefineNivel/Fc_NivelHierarquico): cada segmento do posit_level
 * é o próprio código com 3 dígitos; profundidade = nº de pontos.
 * PROMOVIDA de modules/categories quando o plano de contas virou o 2º
 * consumidor (regra de promoção). Funções PURAS — categories-tree.test.ts.
 */

/** Código → segmento ('7' → '007'; acima de 999 imprime inteiro). */
export function pathSegment(id: number): string {
  return String(id).padStart(3, '0')
}

/** Caminho do filho: pai + '.' + código (raiz = só o código). */
export function childPath(parentPath: string | null, id: number): string {
  const segment = pathSegment(id)
  return parentPath ? `${parentPath}.${segment}` : segment
}

/** id do PAI derivado do caminho (null = nível raiz). */
export function parentIdFromPath(path: string | null): number | null {
  if (!path) return null
  const segments = path.split('.')
  return segments.length > 1
    ? Number(segments[segments.length - 2])
    : null
}

/** [candidate] é o próprio nó ou um descendente dele? (proíbe ciclo). */
export function isSelfOrDescendant(nodePath: string, candidatePath: string): boolean {
  return candidatePath === nodePath || candidatePath.startsWith(`${nodePath}.`)
}
