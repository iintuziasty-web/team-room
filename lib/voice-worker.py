"""Private local transcription worker. Audio never goes to an AI API."""
import base64
import io
import json
import os
import sys

os.environ['HF_HUB_DISABLE_TELEMETRY'] = '1'
os.environ['DO_NOT_TRACK'] = '1'
from faster_whisper import WhisperModel

try:
    os.nice(10)
except (AttributeError, OSError):
    pass

folder = sys.argv[1]
if len(sys.argv) > 2 and sys.argv[2] == 'prepare':
    WhisperModel('small', device='cpu', compute_type='int8', cpu_threads=2,
                 download_root=folder)
    print(json.dumps({'ready': True}), flush=True)
    sys.exit(0)

model = WhisperModel('small', device='cpu', compute_type='int8', cpu_threads=2,
                     download_root=folder, local_files_only=True)
for line in sys.stdin:
    request = {}
    try:
        request = json.loads(line)
        raw = base64.b64decode(request['audio'], validate=True)
        if len(raw) > 6 * 1024 * 1024:
            raise ValueError('Recording too large')
        # Decode locally with bundled PyAV; reject long or invalid containers
        # before inference, regardless of the client duration field.
        import av
        seconds = 0
        with av.open(io.BytesIO(raw)) as container:
            for frame in container.decode(audio=0):
                seconds += frame.samples / frame.sample_rate
                if seconds > 125:
                    raise ValueError('Recording too long')
        from faster_whisper.audio import decode_audio
        audio = decode_audio(io.BytesIO(raw), sampling_rate=16000)
        if len(audio) > 16000 * 125:
            raise ValueError('Recording too long')
        segments, info = model.transcribe(audio, language=request['language'],
                                         beam_size=3, vad_filter=True,
                                         condition_on_previous_text=False)
        text = ' '.join(segment.text.strip() for segment in segments).strip()
        print(json.dumps({'id': request['id'], 'text': text[:12000]}, ensure_ascii=False), flush=True)
    except Exception:
        print(json.dumps({'id': request.get('id'), 'error': 'Не удалось распознать запись. Попробуй ещё раз.'}), flush=True)

    finally:
        # Release raw recordings while the process waits for the next request.
        request.clear()
        raw = None
        audio = None
        line = ''
