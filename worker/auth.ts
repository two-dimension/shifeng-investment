const encoder = new TextEncoder()

async function digest(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)))
}

function timingSafeEqual(left: Uint8Array, right: Uint8Array): boolean {
  let difference = left.byteLength ^ right.byteLength
  const length = Math.max(left.byteLength, right.byteLength)

  for (let index = 0; index < length; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0)
  }

  return difference === 0
}

export async function authorizeBearer(request: Request, expected: string): Promise<boolean> {
  const authorization = request.headers.get('Authorization') ?? ''
  const match = /^Bearer ([^\s]+)$/.exec(authorization)
  const supplied = match?.[1] ?? ''
  const [suppliedDigest, expectedDigest] = await Promise.all([
    digest(supplied),
    digest(expected),
  ])

  return expected.length > 0 && match !== null && timingSafeEqual(suppliedDigest, expectedDigest)
}
