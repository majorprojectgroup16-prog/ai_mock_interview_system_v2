import { NextResponse } from 'next/server';

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const text = body.text || '';
    if (!text.trim()) {
      return NextResponse.json({ skills: [], soft_skills: [] });
    }

    // Proxy to Python backend
    console.log('[extract-skills] proxying to python backend, length=', text.length);
    const backendUrl = process.env.PYTHON_BACKEND_URL || 'http://127.0.0.1:8000/extract';
    const res = await fetch(backendUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ text }),
    });

    // Log response status for easier debugging
    console.log(`[extract-skills] python backend responded: ${res.status}`);

    if (!res.ok) {
      const errBody = await res.text();
      console.error('[extract-skills] backend error body:', errBody);
      return NextResponse.json({
        skills: [],
        soft_skills: [],
        warning: 'Python backend error',
        details: errBody,
      });
    }

    const data = await res.json();
    console.log('[extract-skills] extracted skills:', data.skills);
    return NextResponse.json(data);
  } catch (err: any) {
    console.error('Error in /api/extract-skills:', err);
    return NextResponse.json({
      skills: [],
      soft_skills: [],
      warning: 'Python backend unavailable',
      details: err?.message || String(err),
    });
  }
}
