'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { provideRealTimeFeedback } from '@/ai/flows/provide-real-time-feedback';
import type { TranscriptItem } from '@/lib/types';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useToast } from '@/hooks/use-toast';
import { ArrowRight, Bot, Loader2, User, Mic, MicOff } from 'lucide-react';
import { simulateInterview } from '@/ai/flows/simulate-interview';
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert';


// Declare the speech recognition type for window
declare global {
  interface Window {
    SpeechRecognition: any;
    webkitSpeechRecognition: any;
  }
}

export default function InterviewSessionPage() {
  const router = useRouter();
  const { toast } = useToast();
  const [jobDescription, setJobDescription] = useState('');
  const [resume, setResume] = useState('');
  const [interviewQuestions, setInterviewQuestions] = useState<string[]>([]);
  const [currentQuestionIndex, setCurrentQuestionIndex] = useState(0);
  const [userAnswer, setUserAnswer] = useState('');
  const [transcript, setTranscript] = useState<TranscriptItem[]>([]);
  const [feedback, setFeedback] = useState('');
  const [isFeedbackLoading, setIsFeedbackLoading] = useState(false);
  const [extractedSkills, setExtractedSkills] = useState<string[] | undefined>(undefined);
  const [isInitialized, setIsInitialized] = useState(false);
  const [areQuestionsLoading, setAreQuestionsLoading] = useState(true);

  // New state for speech recognition
  const [isRecording, setIsRecording] = useState(false);
  const [hasMicrophonePermission, setHasMicrophonePermission] = useState(false);
  const [hasCameraPermission, setHasCameraPermission] = useState(false);
  const [recordedVideoBlob, setRecordedVideoBlob] = useState<Blob | null>(null);
  const [recordedVideoUrl, setRecordedVideoUrl] = useState<string>('');
  const [detectedEmotion, setDetectedEmotion] = useState('');
  const [isEmotionLoading, setIsEmotionLoading] = useState(false);
  const recognitionRef = useRef<any>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordingMimeTypeRef = useRef<string>('video/webm');
  const videoChunksRef = useRef<Blob[]>([]);

  const scrollAreaRef = useRef<HTMLDivElement>(null);

  // Text to Speech function
  const speak = useCallback((text: string) => {
    if (typeof window !== 'undefined' && window.speechSynthesis) {
      // Cancel any ongoing speech before starting a new one
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(text);
      // You can configure voice, rate, pitch etc. here if needed
      // const voices = window.speechSynthesis.getVoices();
      // utterance.voice = voices[0];
      utterance.rate = 0.9;
      utterance.pitch = 1;
      window.speechSynthesis.speak(utterance);
    }
  }, []);

  useEffect(() => {
    const storedJD = localStorage.getItem('jobDescription');
    const storedResume = localStorage.getItem('resume');

    if (!storedJD || !storedResume) {
      toast({
        variant: 'destructive',
        title: 'Error',
        description: 'Interview details not found. Please start over.',
      });
      router.push('/interview');
    } else {
      setJobDescription(storedJD);
      setResume(storedResume);
      setIsInitialized(true);
    }
  }, [router, toast]);
  
  // Request microphone permission on component mount
  useEffect(() => {
    const getMicrophonePermission = async () => {
      if (typeof window !== 'undefined' && 'mediaDevices' in navigator) {
        try {
          const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
          stream.getTracks().forEach((track) => track.stop());
          setHasMicrophonePermission(true);
          setHasCameraPermission(true);
        } catch (error) {
          console.error('Microphone/camera access denied:', error);
          setHasMicrophonePermission(false);
          setHasCameraPermission(false);
          toast({
            variant: 'destructive',
            title: 'Media Access Denied',
            description: 'Please enable microphone and camera permissions in your browser settings to use voice input with video emotion analysis.',
          });
        }
      }
    };
    getMicrophonePermission();
  }, [toast]);


  // Speech recognition retry state
  const [speechError, setSpeechError] = useState<string | null>(null);
  const [speechRetryCount, setSpeechRetryCount] = useState(0);
  const MAX_SPEECH_RETRIES = 2;

  // Initialize Speech Recognition
  useEffect(() => {
    return () => {
      if (mediaStreamRef.current) {
        mediaStreamRef.current.getTracks().forEach((track) => track.stop());
        mediaStreamRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (!recordedVideoBlob) {
      setRecordedVideoUrl('');
      return;
    }

    const objectUrl = URL.createObjectURL(recordedVideoBlob);
    setRecordedVideoUrl(objectUrl);

    return () => {
      URL.revokeObjectURL(objectUrl);
    };
  }, [recordedVideoBlob]);

  const startVideoRecording = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
      mediaStreamRef.current = stream;
      videoChunksRef.current = [];

      const preferredMimeTypes = [
        'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
        'video/mp4',
        'video/webm;codecs=vp9,opus',
        'video/webm;codecs=vp8,opus',
        'video/webm',
      ];
      const supportedMimeType = preferredMimeTypes.find((type) => MediaRecorder.isTypeSupported(type));
      const recorder = supportedMimeType ? new MediaRecorder(stream, { mimeType: supportedMimeType }) : new MediaRecorder(stream);
      recordingMimeTypeRef.current = recorder.mimeType || supportedMimeType || 'video/webm';

      recorder.ondataavailable = (event: BlobEvent) => {
        if (event.data && event.data.size > 0) {
          videoChunksRef.current.push(event.data);
        }
      };

      recorder.start();
      mediaRecorderRef.current = recorder;
      setRecordedVideoBlob(null);
      return true;
    } catch (error) {
      console.error('Could not start video recording:', error);
      toast({
        variant: 'destructive',
        title: 'Video Recording Error',
        description: 'Could not access camera for answer recording.',
      });
      return false;
    }
  }, [toast]);

  const stopVideoRecording = useCallback(async (): Promise<Blob | null> => {
    const recorder = mediaRecorderRef.current;
    if (!recorder) {
      return null;
    }

    return new Promise((resolve) => {
      const finalize = () => {
        const blobType =
          recordingMimeTypeRef.current ||
          videoChunksRef.current[0]?.type ||
          'video/webm';
        const blob =
          videoChunksRef.current.length > 0
            ? new Blob(videoChunksRef.current, { type: blobType })
            : null;
        setRecordedVideoBlob(blob);
        videoChunksRef.current = [];
        mediaRecorderRef.current = null;
        if (mediaStreamRef.current) {
          mediaStreamRef.current.getTracks().forEach((track) => track.stop());
          mediaStreamRef.current = null;
        }
        resolve(blob);
      };

      recorder.addEventListener('stop', finalize, { once: true });
      if (recorder.state !== 'inactive') {
        recorder.stop();
      } else {
        finalize();
      }
    });
  }, []);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (SpeechRecognition) {
        const recognition = new SpeechRecognition();
        recognition.continuous = true;
        recognition.interimResults = true;
        recognition.lang = 'en-US';

        recognition.onresult = (event: any) => {
          let interimTranscript = '';
          let finalTranscript = '';
          for (let i = event.resultIndex; i < event.results.length; ++i) {
            if (event.results[i].isFinal) {
              finalTranscript += event.results[i][0].transcript;
            } else {
              interimTranscript += event.results[i][0].transcript;
            }
          }
          // Update the textarea with the final transcript part, appended to existing text
          setUserAnswer(prevAnswer => prevAnswer + finalTranscript);
        };

        recognition.onerror = (event: any) => {
          console.error('Speech recognition error', event.error);
          const err = event.error;

          // Handle network errors explicitly with retry and clear guidance
          if (err === 'network') {
            setSpeechError('network');
            toast({
              variant: 'destructive',
              title: 'Speech recognition network error',
              description:
                'Speech recognition failed due to a network error. Check your internet connection, ensure your browser supports cloud speech services (Chrome), or try typing your answer. Retrying automatically...',
            });

            // Retry with exponential backoff up to MAX_SPEECH_RETRIES
            if (speechRetryCount < MAX_SPEECH_RETRIES) {
              const delay = Math.pow(2, speechRetryCount) * 1000; // 1s, 2s
              setTimeout(() => {
                try {
                  recognition.start();
                  setIsRecording(true);
                  setSpeechError(null);
                  setSpeechRetryCount(prev => prev + 1);
                  console.log('Retrying speech recognition (attempt)', speechRetryCount + 1);
                } catch (e) {
                  console.error('Retry start failed', e);
                }
              }, delay);
            } else {
              // Give up after retries
              setIsRecording(false);
              toast({
                variant: 'destructive',
                title: 'Speech recognition unavailable',
                description: 'Automatic retries failed. Please type your answer or reload the page and try again.',
              });
            }

            return;
          }

          if (err !== 'no-speech' && err !== 'aborted') {
            toast({
              variant: 'destructive',
              title: 'Speech Error',
              description: `An error occurred with speech recognition: ${err}`,
            });
          }

          // Always set recording to false on error to allow restart
          setIsRecording(false);
        };
        
        recognition.onend = () => {
          setIsRecording(false);
          void stopVideoRecording();
        };

        recognitionRef.current = recognition;
      } else {
        toast({
            title: 'Browser Not Supported',
            description: 'Speech recognition is not supported in your browser.',
        });
      }
    }
  }, [toast, speechRetryCount, stopVideoRecording]);


  const toggleRecording = async () => {
    if (!recognitionRef.current || !hasMicrophonePermission || !hasCameraPermission) {
        if(!hasMicrophonePermission || !hasCameraPermission) {
            toast({
                variant: 'destructive',
                title: 'Cannot Record',
                description: 'Microphone and camera access are required.',
            });
        }
        return;
    }

    if (isRecording) {
      recognitionRef.current.stop();
      setIsRecording(false);
      await stopVideoRecording();
    } else {
      // Reset retry state whenever user explicitly starts recording
      setSpeechError(null);
      setSpeechRetryCount(0);
      setDetectedEmotion('');

      const videoStarted = await startVideoRecording();
      if (!videoStarted) {
        return;
      }

      // A more robust way to prevent the InvalidStateError
      try {
        recognitionRef.current.start();
        setIsRecording(true);
      } catch (e) {
         if (e instanceof Error && e.name === 'InvalidStateError') {
          // This can happen if recognition is already starting.
          // We can ignore this, as our state will be synced by onstart.
          console.log("Speech recognition already starting.");
        } else {
          console.error("Could not start speech recognition:", e);
          await stopVideoRecording();
           toast({
              variant: 'destructive',
              title: 'Speech Error',
              description: 'Could not start voice recording.',
            });
        }
      }
    }
  };

  const analyzeEmotion = useCallback(async (videoBlob: Blob): Promise<boolean> => {
    setIsEmotionLoading(true);
    try {
      const formData = new FormData();
      const extension = videoBlob.type.includes('mp4') ? 'mp4' : 'webm';
      formData.append('video', videoBlob, `answer-${Date.now()}.${extension}`);
      formData.append('frameEveryN', '10');

      const res = await fetch('/api/analyze-emotion', {
        method: 'POST',
        body: formData,
      });

      if (!res.ok) {
        const errorData = await res.json().catch(() => null);
        const backendMessage =
          errorData?.details || errorData?.error || `Request failed with status ${res.status}`;
        toast({
          variant: 'destructive',
          title: 'Emotion Analysis Error',
          description: typeof backendMessage === 'string' ? backendMessage : 'Could not analyze emotion.',
        });
        return false;
      }

      const data = await res.json();
      setDetectedEmotion(data.final_emotion || '');
      return true;
    } catch (error) {
      console.error('Emotion analysis error:', error);
      toast({
        variant: 'destructive',
        title: 'Emotion Analysis Error',
        description: 'Could not analyze your video emotion for this answer.',
      });
      return false;
    } finally {
      setIsEmotionLoading(false);
    }
  }, [toast]);


  useEffect(() => {
    if (isInitialized) {
      const getQuestions = async () => {
        try {
          setAreQuestionsLoading(true);

          // If either document was extracted from a PDF, call local model to extract skills first
          const jdFromPdf = localStorage.getItem('jobDescriptionExtractedFromPdf') === 'true';
          const resumeFromPdf = localStorage.getItem('resumeExtractedFromPdf') === 'true';

          let extractedSkills: string[] | undefined = undefined;
          if (jdFromPdf || resumeFromPdf) {
            try {
              const combinedText = `${jdFromPdf ? jobDescription : ''}\n${resumeFromPdf ? resume : ''}`.trim();
              const res = await fetch('/api/extract-skills', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text: combinedText }),
              });
              if (res.ok) {
                const data = await res.json();
                extractedSkills = Array.isArray(data.skills) ? data.skills : [];
                setExtractedSkills(extractedSkills);
                console.log('[session] extracted skills from python backend:', extractedSkills);
                // show a quick toast so user knows extraction happened
                if (extractedSkills.length > 0) {
                  toast({ title: 'Skills extracted', description: extractedSkills.slice(0,5).join(', ') });
                } else {
                  toast({ title: 'No skills found', description: 'The extractor did not find explicit skills in the uploaded PDFs.' });
                }
              } else {
                console.warn('Skill extraction API returned non-OK response');
                toast({ title: 'Skill extraction failed', description: 'Proceeding without extracted skills.' });
              }
            } catch (err) {
              console.error('Error calling skill extraction API:', err);
            }
          }

          const result = await simulateInterview({
            jobDescription,
            resume,
            extractedSkills,
          });

          setInterviewQuestions(result.questions);
          // Speak the first question
          if (result.questions.length > 0) {
            speak(result.questions[0]);
          }
        } catch (error) {
          console.error('Error getting interview questions:', error);
          toast({
            variant: 'destructive',
            title: 'AI Error',
            description: 'Could not generate interview questions. Please try again.',
          });
          router.push('/interview');
        } finally {
          setAreQuestionsLoading(false);
        }
      };
      getQuestions();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isInitialized, jobDescription, resume, router, toast]); // speak is stable

  useEffect(() => {
    if (scrollAreaRef.current) {
      scrollAreaRef.current.scrollTo({ top: scrollAreaRef.current.scrollHeight, behavior: 'smooth' });
    }
  }, [transcript]);

  const handleAnswerSubmit = async () => {
    let answerVideoBlob = recordedVideoBlob;
    setDetectedEmotion('');

    if (isRecording) {
      recognitionRef.current?.stop();
      setIsRecording(false);
      answerVideoBlob = await stopVideoRecording();
    }

    if (!userAnswer.trim()) {
      toast({
        variant: 'destructive',
        title: 'Empty Answer',
        description: 'Please provide an answer to the question.',
      });
      return;
    }

    const currentQuestion = interviewQuestions[currentQuestionIndex];
    setTranscript((prev) => [
      ...prev,
      { speaker: 'interviewer', text: currentQuestion },
      { speaker: 'user', text: userAnswer },
    ]);
    
    setIsFeedbackLoading(true);
    setFeedback('');

    try {
      if (answerVideoBlob) {
        await analyzeEmotion(answerVideoBlob);
      }

      const feedbackResult = await provideRealTimeFeedback({
        jobDescription,
        resume,
        interviewQuestion: currentQuestion,
        userResponse: userAnswer,
        extractedSkills,
      });
      setFeedback(feedbackResult.feedback);
      speak("Here's some feedback.");
    } catch (error) {
      console.error('Error getting feedback:', error);
      toast({
        variant: 'destructive',
        title: 'AI Error',
        description: 'Could not get feedback from the AI. Please try again.',
      });
    } finally {
      setIsFeedbackLoading(false);
      setUserAnswer('');
    }
  };

  const handleNextQuestion = () => {
    if (currentQuestionIndex < interviewQuestions.length - 1) {
      const nextQuestionIndex = currentQuestionIndex + 1;
      setCurrentQuestionIndex(nextQuestionIndex);
      setFeedback('');
      // Speak the next question
      speak(interviewQuestions[nextQuestionIndex]);
    } else {
      handleEndInterview();
    }
  };

  const handleEndInterview = () => {
    // Stop any ongoing speech or recording
    if (typeof window !== 'undefined' && window.speechSynthesis) {
        window.speechSynthesis.cancel();
    }
    if (isRecording && recognitionRef.current) {
        recognitionRef.current.stop();
        setIsRecording(false);
        void stopVideoRecording();
    }
    
    localStorage.setItem('interviewTranscript', JSON.stringify(transcript));
    toast({
      title: 'Interview Complete',
      description: 'Generating your performance report...',
    });
    router.push('/interview/report');
  };

  if (!isInitialized || areQuestionsLoading) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-4">
        <Loader2 className="h-12 w-12 animate-spin text-primary" />
        <h2 className="text-xl font-semibold">Generating your interview questions...</h2>
        <p className="text-muted-foreground">The AI is tailoring questions for you.</p>
      </div>
    );
  }

  return (
    <div className="container py-8 flex-1">
      <div className="grid md:grid-cols-2 gap-8 h-full">
        <Card className="flex flex-col">
          <CardHeader>
            <CardTitle>Interview Transcript</CardTitle>
          </CardHeader>
          <CardContent className="flex-1 flex flex-col min-h-0">
            <ScrollArea className="flex-1 pr-4 -mr-4" ref={scrollAreaRef}>
              <div className="space-y-4">
                {transcript.map((item, index) => (
                  <div key={index} className="flex items-start gap-3">
                    <div className="flex-shrink-0">
                      {item.speaker === 'interviewer' ? 
                        <span className="flex h-8 w-8 items-center justify-center rounded-full bg-primary text-primary-foreground"><Bot size={18} /></span> :
                        <span className="flex h-8 w-8 items-center justify-center rounded-full bg-secondary text-secondary-foreground"><User size={18} /></span>
                      }
                    </div>
                    <div className="flex-1 rounded-lg bg-muted p-3 text-sm">
                      <p className="font-semibold mb-1">{item.speaker === 'interviewer' ? 'Interviewer' : 'You'}</p>
                      <p className="text-muted-foreground whitespace-pre-wrap">{item.text}</p>
                    </div>
                  </div>
                ))}
              </div>
            </ScrollArea>
          </CardContent>
        </Card>
        <div className="flex flex-col gap-8">
          <Card>
            <CardHeader>
              <CardTitle>Question {currentQuestionIndex + 1} of {interviewQuestions.length}</CardTitle>
              <CardDescription className="text-lg pt-2">{interviewQuestions[currentQuestionIndex]}</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                 {(!hasMicrophonePermission || !hasCameraPermission) && (
                    <Alert variant="destructive">
                      <AlertTitle>Microphone and Camera Access Required</AlertTitle>
                      <AlertDescription>
                        Please allow microphone and camera access in your browser to use voice input and emotion video analysis.
                      </AlertDescription>
                    </Alert>
                  )}
                <div className="relative">
                    <Textarea
                    placeholder="Type your answer or use the microphone to speak..."
                    value={userAnswer}
                    onChange={(e) => setUserAnswer(e.target.value)}
                    className="min-h-[150px] pr-12"
                    disabled={isFeedbackLoading}
                    />
                    <Button 
                        size="icon" 
                        variant={isRecording ? 'destructive' : 'outline'}
                        onClick={toggleRecording} 
                        className="absolute bottom-3 right-3"
                        aria-label={isRecording ? 'Stop recording' : 'Start recording'}
                        disabled={!hasMicrophonePermission || !hasCameraPermission}
                    >
                        {isRecording ? <MicOff size={20} /> : <Mic size={20} />}
                    </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  {isRecording
                    ? 'Recording your answer video and voice...'
                    : recordedVideoBlob
                      ? 'Answer video recorded and ready for emotion analysis.'
                      : 'Start recording to capture your answer video.'}
                </p>

                {/* Show small alert when speech network error occurs */}
                {speechError === 'network' && (
                  <Alert variant="destructive" className="mt-2">
                    <AlertTitle>Speech recognition network error</AlertTitle>
                    <AlertDescription>
                      Speech recognition is currently unavailable due to a network error. Check your connection or try typing your answer. You can also reload the page to retry.
                    </AlertDescription>
                  </Alert>
                )}
                <Button onClick={handleAnswerSubmit} disabled={isFeedbackLoading || !userAnswer} className="w-full">
                  {isFeedbackLoading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                  Submit Answer
                </Button>
              </div>
            </CardContent>
          </Card>
          
          <Card className="flex-1 flex flex-col">
            <CardHeader>
              <CardTitle>Real-time Feedback</CardTitle>
            </CardHeader>
            <CardContent className="flex-1 flex flex-col justify-between">
              <div className="flex-1">
                {isFeedbackLoading && <div className="flex items-center gap-2 text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin"/> Analyzing...</div>}
                {isEmotionLoading && <p className="text-sm text-muted-foreground mb-2">Analyzing recorded video emotion...</p>}
                {detectedEmotion && <p className="text-sm mb-2"><span className="font-semibold">Detected emotion:</span> {detectedEmotion}</p>}
                {feedback && <p className="text-sm text-muted-foreground whitespace-pre-wrap">{feedback}</p>}
                {!isFeedbackLoading && !feedback && <p className="text-sm text-muted-foreground">Submit your answer to get AI feedback.</p>}
                {recordedVideoUrl && (
                  <div className="mt-3">
                    <p className="text-xs text-muted-foreground mb-2">Last recorded answer video:</p>
                    <video src={recordedVideoUrl} controls className="w-full rounded-md border" />
                  </div>
                )}
              </div>
              <div className="mt-4 flex gap-4">
                <Button onClick={handleNextQuestion} variant="outline" className="flex-1" disabled={!feedback && !isFeedbackLoading}>
                  {currentQuestionIndex < interviewQuestions.length - 1 ? 'Next Question' : 'Finish Interview'} <ArrowRight className="ml-2 h-4 w-4" />
                </Button>
                <Button onClick={handleEndInterview} variant="destructive" className="flex-1">
                  End Interview Now
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
