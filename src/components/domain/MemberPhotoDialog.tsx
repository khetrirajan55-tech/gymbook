import { useRef, useState } from 'react'
import { Camera, ImageUp, Trash2 } from 'lucide-react'
import type { Member } from '@/domain/types'
import { Modal } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'
import { Avatar } from '@/components/ui/misc'
import { useToast } from '@/components/ui/Toast'
import { CameraDialog } from './CameraDialog'
import { setMemberPhoto } from '@/data/services/members'
import { fileToSmallDataUrl } from '@/lib/image'
import { errorMessage } from '@/data/errors'

/**
 * Opened by tapping the photo on a member's page: the photo at full size, with take, upload and
 * remove beside it. A change is saved straight away; the page refreshes itself from the store.
 */
export function MemberPhotoDialog({ member, onClose }: { member: Member; onClose: () => void }) {
  const toast = useToast()
  const fileRef = useRef<HTMLInputElement>(null)
  const [cameraOpen, setCameraOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const save = async (photoDataUrl: string | undefined) => {
    setBusy(true)
    setError(null)
    try {
      await setMemberPhoto(member.id, member.rev, photoDataUrl)
      toast.success(photoDataUrl ? 'Photo updated' : 'Photo removed')
      onClose()
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  const onFile = async (file: File | undefined) => {
    if (fileRef.current) fileRef.current.value = ''
    if (!file) return
    try {
      await save(await fileToSmallDataUrl(file))
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  if (cameraOpen) {
    return <CameraDialog onClose={() => setCameraOpen(false)} onCapture={(dataUrl) => { setCameraOpen(false); void save(dataUrl) }} onUploadInstead={() => { setCameraOpen(false); fileRef.current?.click() }} />
  }

  return (
    <Modal open onClose={onClose} title={member.name} description={member.photoDataUrl ? 'Profile photo' : 'No photo yet'} size="sm">
      <div className="flex flex-col items-center gap-4">
        {member.photoDataUrl ? (
          <img src={member.photoDataUrl} alt={`Photo of ${member.name}`} className="aspect-square w-full max-w-[280px] rounded-2xl object-cover ring-1 ring-line" />
        ) : (
          <div className="flex w-full items-center justify-center rounded-2xl bg-sunken py-8">
            <Avatar name={member.name} size="xl" />
          </div>
        )}
        <input ref={fileRef} type="file" accept="image/*" className="sr-only" aria-label="Upload a photo" onChange={(e) => void onFile(e.target.files?.[0])} />
        <div className="grid w-full grid-cols-2 gap-2">
          <Button variant="secondary" icon={<Camera className="h-4 w-4" aria-hidden />} disabled={busy} onClick={() => { setError(null); setCameraOpen(true) }}>
            Take photo
          </Button>
          <Button variant="secondary" icon={<ImageUp className="h-4 w-4" aria-hidden />} disabled={busy} onClick={() => fileRef.current?.click()}>
            Upload photo
          </Button>
          {member.photoDataUrl ? (
            <Button variant="ghost" className="col-span-2" icon={<Trash2 className="h-4 w-4" aria-hidden />} loading={busy} onClick={() => void save(undefined)}>
              Remove photo
            </Button>
          ) : null}
        </div>
        {error ? <p role="alert" className="text-sm font-medium text-danger">{error}</p> : null}
      </div>
    </Modal>
  )
}
