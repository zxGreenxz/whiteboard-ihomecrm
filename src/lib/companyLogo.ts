import { uploadFile } from './storage';

export type LogoSaveOutcome =
  | { status: 'saved'; url: string }
  | { status: 'uploaded'; url: string; error: unknown };

export async function saveCompanyLogo(file: File, userId: string, persist: (url: string) => Promise<unknown>): Promise<LogoSaveOutcome> {
  const extension = file.name.split('.').pop()?.replace(/[^a-z0-9]/gi, '') || 'png';
  const url = await uploadFile('avatars', `${userId}/company-logo-${crypto.randomUUID()}.${extension}`, file);
  try {
    await persist(url);
  } catch (error) {
    return { status: 'uploaded', url, error };
  }
  return { status: 'saved', url };
}
