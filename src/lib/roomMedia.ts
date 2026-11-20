/** The media array keeps photo cover order. The viewer starts with the room tour. */
export function isRoomVideo(url: string): boolean {
  return /\.mp4$/i.test(url.replace(/[?#].*$/, ''));
}

export function roomAlbum(items: string[]): string[] {
  return [...items.filter(isRoomVideo), ...items.filter(item => !isRoomVideo(item))];
}

export function roomPhotoCount(items: string[]): number {
  return items.filter(url => !isRoomVideo(url)).length;
}
