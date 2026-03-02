import { NextResponse } from 'next/server';

export async function POST(request: Request) {
  try {
    const incoming = await request.formData();
    const video = incoming.get('video');
    const frameEveryN = incoming.get('frameEveryN')?.toString() ?? '10';

    const isFileLike =
      !!video &&
      typeof video === 'object' &&
      'arrayBuffer' in video &&
      typeof (video as Blob).arrayBuffer === 'function';

    if (!isFileLike) {
      return NextResponse.json({ error: 'video file is required' }, { status: 400 });
    }

    const backendUrl = process.env.PYTHON_EMOTION_BACKEND_URL || 'http://127.0.0.1:8000/analyze-emotion';

    const proxyFormData = new FormData();
    const videoFile = video as File;
    proxyFormData.append('video', videoFile, videoFile.name || 'answer.webm');
    proxyFormData.append('frame_every_n', frameEveryN);

    const res = await fetch(backendUrl, {
      method: 'POST',
      body: proxyFormData,
    });

    if (!res.ok) {
      const errBody = await res.text();
      return NextResponse.json(
        { error: 'Python backend emotion analysis failed', details: errBody },
        { status: 502 }
      );
    }

    const data = await res.json();
    return NextResponse.json(data);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[analyze-emotion] route error:', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
