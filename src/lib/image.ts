/** Turn a picked image into a JPEG data URL for storage: kept sharp (up to 720px), since the full picture is stored apart from the lists. */
export async function fileToSmallDataUrl(file: File, max = 720): Promise<string> {
  if (!file.type.startsWith('image/')) throw new Error('Choose an image file (JPEG, PNG or WebP).')
  if (file.size > 10 * 1024 * 1024) throw new Error('Image is larger than 10 MB. Choose a smaller file.')
  const bitmap = await createImageBitmap(file).catch(() => {
    throw new Error('Could not read this image.')
  })
  const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height))
  const w = Math.max(1, Math.round(bitmap.width * scale))
  const h = Math.max(1, Math.round(bitmap.height * scale))
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Could not process this image.')
  ctx.drawImage(bitmap, 0, 0, w, h)
  bitmap.close()
  return canvas.toDataURL('image/jpeg', 0.9)
}

/**
 * A small square-ish thumbnail of a photo, for cards and lists. Where the browser cannot draw (or the
 * picture is already tiny) the picture itself is returned, so nothing is ever lost by asking.
 */
export async function makeThumb(dataUrl: string, max = 128): Promise<string> {
  if (typeof document === 'undefined' || typeof createImageBitmap === 'undefined') return dataUrl
  try {
    // Decoded by hand rather than with fetch(): a page's content policy may not allow fetching data: URLs.
    const comma = dataUrl.indexOf(',')
    const binary = atob(dataUrl.slice(comma + 1))
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    const bitmap = await createImageBitmap(new Blob([bytes], { type: /^data:([^;,]+)/.exec(dataUrl)?.[1] ?? 'image/jpeg' }))
    // Already thumbnail-sized: keep it exactly as it is.
    if (Math.max(bitmap.width, bitmap.height) <= max) {
      bitmap.close()
      return dataUrl
    }
    const scale = max / Math.max(bitmap.width, bitmap.height)
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(bitmap.width * scale))
    canvas.height = Math.max(1, Math.round(bitmap.height * scale))
    const ctx = canvas.getContext('2d')
    if (!ctx) return dataUrl
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    bitmap.close()
    return canvas.toDataURL('image/jpeg', 0.8)
  } catch {
    return dataUrl
  }
}
