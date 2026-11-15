export type CameraFacing = 'environment' | 'user'

export function cameraSupported(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.mediaDevices?.getUserMedia === 'function'
}

/** Ask for a video-only stream. `facing` is a preference: a laptop with one webcam still opens it. */
export function openCamera(facing: CameraFacing): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { facingMode: { ideal: facing }, width: { ideal: 1280 }, height: { ideal: 720 } },
  })
}

export function stopCamera(stream: MediaStream | null): void {
  stream?.getTracks().forEach((t) => t.stop())
}

/** A message the front desk can act on, for each way a camera can fail to open. */
export function cameraErrorMessage(err: unknown): string {
  const name = err instanceof Error ? err.name : ''
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'Camera access is blocked. Allow the camera for this site in the browser settings, then try again.'
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'No camera was found on this device.'
  if (name === 'NotReadableError' || name === 'AbortError') return 'The camera is busy in another app. Close that app, then try again.'
  return 'The camera could not be started.'
}

export const CAMERA_UNSUPPORTED = 'This browser cannot open the camera on this page.'

/**
 * Centre-crop the current frame of a playing video to a small square JPEG data URL.
 * Square because member photos are shown as round avatars; small because photos live in IndexedDB and in backups.
 */
export function videoFrameToSmallDataUrl(video: HTMLVideoElement, size = 720): string {
  const vw = video.videoWidth
  const vh = video.videoHeight
  if (!vw || !vh) throw new Error('The camera is not ready yet. Try again in a moment.')
  const side = Math.min(vw, vh)
  const out = Math.min(size, side)
  const canvas = document.createElement('canvas')
  canvas.width = out
  canvas.height = out
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Could not process this photo.')
  ctx.drawImage(video, (vw - side) / 2, (vh - side) / 2, side, side, 0, 0, out, out)
  return canvas.toDataURL('image/jpeg', 0.9)
}
