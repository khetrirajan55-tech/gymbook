import { getDb } from './db'
import { getSettings, updateSettings } from './services/settings'
import { seedSampleData } from './sample'
import { splitMemberPhotos } from './services/photos'
import type { Settings } from '@/domain/types'

/** Open the database and load settings. Throws a StorageError when storage is unusable. */
export async function bootstrap(): Promise<Settings> {
  await getDb()
  // Older data keeps full pictures inside member records; move them out in the background.
  void splitMemberPhotos().catch(() => undefined)
  return getSettings()
}

export async function chooseStartMode(mode: 'sample' | 'empty', timezone: string): Promise<void> {
  if (mode === 'sample') {
    await seedSampleData(timezone)
  } else {
    await updateSettings({ dataMode: 'empty', timezone })
  }
}
