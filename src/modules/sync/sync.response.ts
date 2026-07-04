export function syncSuccess(institutionId: number, message = 'SAVED') {
  return { id: 200, code: institutionId, message }
}

export function syncError(message: string) {
  return { id: 500, code: 0, message }
}
