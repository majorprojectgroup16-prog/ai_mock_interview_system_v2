from fastapi import FastAPI, HTTPException, File, Form, UploadFile
from pydantic import BaseModel
from typing import List
import uvicorn
import spacy
from skills import extract_hard_skills
import cv2
import torch
from PIL import Image
from collections import Counter
from transformers import ViTForImageClassification, ViTImageProcessor
import tempfile
import os
import subprocess

app = FastAPI()

# Load spaCy model once
try:
    nlp = spacy.load("./model/model-last")
except Exception as e:
    print("Warning: could not load spaCy model: ", e)
    nlp = None

# Load emotion model once
EMOTION_MODEL_NAME = "callmemanu/vit-emotion-model2"
DEVICE = "cuda" if torch.cuda.is_available() else "cpu"
emotion_model = None
emotion_processor = None
emotion_id2label = None

try:
    print("Loading emotion model:", EMOTION_MODEL_NAME)
    emotion_model = ViTForImageClassification.from_pretrained(EMOTION_MODEL_NAME)
    emotion_processor = ViTImageProcessor.from_pretrained(EMOTION_MODEL_NAME)
    emotion_model.to(DEVICE)
    emotion_model.eval()
    emotion_id2label = emotion_model.config.id2label
    print("Emotion model labels:", emotion_id2label)
except Exception as e:
    print("Warning: could not load emotion model: ", e)
    emotion_model = None
    emotion_processor = None
    emotion_id2label = None

class ExtractRequest(BaseModel):
    text: str

class ExtractResponse(BaseModel):
    skills: List[str]
    soft_skills: List[str] = []

class EmotionResponse(BaseModel):
    final_emotion: str
    frame_counts: dict[str, int]
    frames_processed: int
    source_format: str


def resolve_emotion_label(pred_id: int, id2label):
    """Map model class id to a human-readable emotion label."""
    if isinstance(id2label, dict):
        if pred_id in id2label:
            return str(id2label[pred_id])
        if str(pred_id) in id2label:
            return str(id2label[str(pred_id)])
    elif isinstance(id2label, list) and 0 <= pred_id < len(id2label):
        return str(id2label[pred_id])
    return str(pred_id)


def maybe_convert_to_mp4(input_path: str) -> str | None:
    """Convert input video to mp4 using ffmpeg if available."""
    fd, output_path = tempfile.mkstemp(suffix=".mp4")
    os.close(fd)
    try:
        result = subprocess.run(
            ["ffmpeg", "-y", "-i", input_path, "-an", output_path],
            capture_output=True,
            text=True,
            check=False,
        )
        if result.returncode != 0:
            print("ffmpeg conversion failed:", result.stderr)
            if os.path.exists(output_path):
                os.remove(output_path)
            return None
        return output_path
    except FileNotFoundError:
        print("ffmpeg not found; skipping mp4 conversion.")
        if os.path.exists(output_path):
            os.remove(output_path)
        return None


@app.get("/", response_model=dict)
async def health():
    """Simple health endpoint to verify the service is running."""
    return {"status": "ok"}


@app.post("/extract", response_model=ExtractResponse)
async def extract(req: ExtractRequest):
    text = req.text or ""
    print("POST /extract called; text length:", len(text))
    result_skills = []
    soft_skills = []

    # 1) Use span categorizer if model is loaded and has 'sc' spans
    if nlp is not None:
        try:
            doc = nlp(text)
            hard_skill_spans = []
            if "sc" in doc.spans:
                for span in doc.spans["sc"]:
                    hard_skill_spans.append(span.text)
            print("spaCy hard spans:", hard_skill_spans)
            result_skills.extend(hard_skill_spans)
        except Exception as e:
            print("spaCy extraction error:", e)

    # 2) Use keyword-based fallback (skills.py)
    try:
        fallback = extract_hard_skills(text)
        print("Fallback skills:", fallback)
        result_skills.extend(fallback)
    except Exception as e:
        print("Fallback extraction error:", e)

    # Deduplicate and normalize
    normalized = list({s.strip().lower() for s in result_skills if s and isinstance(s, str)})

    print("Returning normalized skills:", normalized)

    # Return skills
    return ExtractResponse(skills=[s for s in normalized], soft_skills=soft_skills)


@app.post("/analyze-emotion", response_model=EmotionResponse)
async def analyze_emotion(
    video: UploadFile = File(...),
    frame_every_n: int = Form(10),
):
    if emotion_model is None or emotion_processor is None or emotion_id2label is None:
        raise HTTPException(status_code=503, detail="Emotion model is not loaded.")

    if frame_every_n <= 0:
        raise HTTPException(status_code=400, detail="frame_every_n must be > 0")

    suffix = os.path.splitext(video.filename or "upload.webm")[1] or ".webm"
    temp_path = None
    converted_mp4_path = None

    try:
        with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
            content = await video.read()
            tmp.write(content)
            temp_path = tmp.name

        source_format = "mp4" if suffix.lower() == ".mp4" else suffix.lower().lstrip(".") or "unknown"
        analysis_path = temp_path

        # Model expectation is mp4. Convert when input format is different.
        if suffix.lower() != ".mp4":
            converted_mp4_path = maybe_convert_to_mp4(temp_path)
            if converted_mp4_path:
                analysis_path = converted_mp4_path
                source_format = "mp4-converted"

        cap = cv2.VideoCapture(analysis_path)
        if not cap.isOpened():
            raise HTTPException(status_code=400, detail="Could not open uploaded video.")

        predictions = []
        frame_count = 0
        used_frames = 0

        while True:
            ret, frame = cap.read()
            if not ret:
                break

            frame_count += 1
            if frame_count % frame_every_n != 0:
                continue

            used_frames += 1
            frame_rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            image = Image.fromarray(frame_rgb)

            inputs = emotion_processor(images=image, return_tensors="pt")
            inputs = {k: v.to(DEVICE) for k, v in inputs.items()}

            with torch.no_grad():
                outputs = emotion_model(**inputs)
                logits = outputs.logits
                pred_id = torch.argmax(logits, dim=-1).item()

            label = resolve_emotion_label(pred_id, emotion_id2label)
            predictions.append(label)

        cap.release()

        if len(predictions) == 0:
            raise HTTPException(
                status_code=422,
                detail="No frames were processed. Upload a longer/valid video or lower frame_every_n.",
            )

        counts = Counter(predictions)
        final_emotion = counts.most_common(1)[0][0]

        return EmotionResponse(
            final_emotion=final_emotion,
            frame_counts=dict(counts),
            frames_processed=used_frames,
            source_format=source_format,
        )
    finally:
        if temp_path and os.path.exists(temp_path):
            os.remove(temp_path)
        if converted_mp4_path and os.path.exists(converted_mp4_path):
            os.remove(converted_mp4_path)


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)
