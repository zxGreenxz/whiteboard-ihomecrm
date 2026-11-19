import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Camera, Video, Square, Upload } from 'lucide-react';
import { MAX_CAPTURE_BYTES, MAX_CLIP_SECONDS } from '@/lib/meter-capture/media';

export function MeterCamera({ onFile, disabled }: { onFile: (file: File, durationSeconds?: number) => void; disabled?: boolean }) {
  const preview = useRef<HTMLVideoElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const timer = useRef<ReturnType<typeof setInterval>>();
  const mounted = useRef(true);
  const [cameraOn, setCameraOn] = useState(false);
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState('');
  useEffect(() => { mounted.current = true; return () => {
    mounted.current = false;
    clearInterval(timer.current);
    if (recorder.current?.state === 'recording') { recorder.current.onstop = null; recorder.current.stop(); }
    stream.current?.getTracks().forEach(track => track.stop());
  }; }, []);

  const openCamera = async () => {
    setError('');
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('Trình duyệt chưa hỗ trợ camera. Dùng nút tải ảnh/clip từ camera điện thoại.');
      const media = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } } });
      if (!mounted.current) { media.getTracks().forEach(track => track.stop()); return; }
      stream.current?.getTracks().forEach(track => track.stop());
      stream.current = media;
      setCameraOn(true);
      if (preview.current) { preview.current.srcObject = media; await preview.current.play(); }
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Chưa mở được camera. Kiểm tra quyền hoặc tải ảnh/clip có sẵn.'); }
  };

  const photo = () => {
    const video = preview.current;
    if (!video?.videoWidth) { setError('Chờ camera hiện rõ rồi chụp.'); return; }
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const context = canvas.getContext('2d');
    if (!context) { setError('Không chụp được ảnh trên trình duyệt này.'); return; }
    context.drawImage(video, 0, 0);
    canvas.toBlob(blob => {
      if (blob) onFile(new File([blob], `dong-ho-${Date.now()}.jpg`, { type: 'image/jpeg' }));
      else setError('Chưa tạo được ảnh. Hãy chụp lại.');
    }, 'image/jpeg', 0.96);
  };

  const startRecording = () => {
    setError('');
    if (!stream.current || typeof MediaRecorder === 'undefined') { setError('Dùng camera điện thoại quay clip rồi chọn Tải ảnh/clip.'); return; }
    try {
      const mimeType = ['video/mp4', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find(type => MediaRecorder.isTypeSupported(type));
      const mediaRecorder = new MediaRecorder(stream.current, { ...(mimeType ? { mimeType } : {}), videoBitsPerSecond: 8_000_000 });
      recorder.current = mediaRecorder;
      const chunks: Blob[] = [];
      let size = 0;
      let failed = false;
      const started = performance.now();
      mediaRecorder.ondataavailable = event => {
        if (!event.data.size) return;
        chunks.push(event.data);
        size += event.data.size;
        if (size > MAX_CAPTURE_BYTES && mediaRecorder.state === 'recording') { failed = true; mediaRecorder.stop(); }
      };
      mediaRecorder.onerror = () => { failed = true; setError('Quay clip bị gián đoạn. Quay lại hoặc tải clip từ điện thoại.'); };
      mediaRecorder.onstop = () => {
        clearInterval(timer.current);
        setRecording(false);
        if (failed || size > MAX_CAPTURE_BYTES) { setError('Clip chưa được lưu. Hãy quay lại clip ngắn hơn (tối đa 100 MB).'); return; }
        const type = mediaRecorder.mimeType.split(';')[0] || 'video/webm';
        onFile(new File(chunks, `dong-ho-${Date.now()}.${type === 'video/mp4' ? 'mp4' : 'webm'}`, { type }), (performance.now() - started) / 1000);
      };
      mediaRecorder.start(1000);
      setSeconds(0);
      setRecording(true);
      timer.current = setInterval(() => {
        const elapsed = Math.floor((performance.now() - started) / 1000);
        setSeconds(elapsed);
        if (elapsed >= MAX_CLIP_SECONDS - 1 && mediaRecorder.state === 'recording') mediaRecorder.stop();
      }, 250);
    } catch { setError('Trình duyệt không quay được clip. Dùng camera điện thoại rồi tải lên.'); }
  };

  return <div className="space-y-2">
    <p className="text-sm text-muted-foreground">Lấy QR và mặt số trong cùng ảnh. Với màn nháy: quay 15–30 giây hết một vòng, thấy QR lúc đầu, giữ một đồng hồ liên tục. Tối đa 60 giây / 100 MB.</p>
    <video ref={preview} muted playsInline className={cameraOn ? 'w-full max-h-64 rounded bg-black object-contain' : 'hidden'} />
    <div className="flex flex-wrap gap-2">
      {!cameraOn && <Button type="button" variant="outline" disabled={disabled} onClick={() => void openCamera()}><Camera className="mr-2 h-4 w-4" />Mở camera</Button>}
      {cameraOn && !recording && <><Button type="button" disabled={disabled} onClick={photo}><Camera className="mr-2 h-4 w-4" />Chụp ảnh</Button><Button type="button" disabled={disabled} variant="outline" onClick={startRecording}><Video className="mr-2 h-4 w-4" />Quay clip</Button></>}
      {recording && <Button type="button" variant="destructive" onClick={() => recorder.current?.stop()}><Square className="mr-2 h-4 w-4" />Dừng · {seconds}s</Button>}
      <Button type="button" disabled={disabled || recording} variant="outline" onClick={() => input.current?.click()}><Upload className="mr-2 h-4 w-4" />Tải ảnh/clip</Button>
      <input ref={input} type="file" accept="image/*,video/mp4,video/webm,video/quicktime" className="hidden" onChange={event => { const file = event.target.files?.[0]; if (file) onFile(file); event.target.value = ''; }} />
    </div>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
  </div>;
}
