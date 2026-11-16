import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  collection,
  doc,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  writeBatch,
} from 'firebase/firestore';
import {
  ArrowRight,
  Check,
  ChevronLeft,
  ChevronRight,
  Eye,
  EyeOff,
  FileText,
  Flag,
  ImagePlus,
  PenTool,
  Presentation,
  Send,
  SkipForward,
  Sparkles,
  Trash2,
  Type,
  Users,
  X,
  ZoomIn,
} from 'lucide-react';
import {
  compressImageToDataUrl,
  db,
  getTimestampMillis,
  handleFirestoreError,
  OperationType,
} from '../firebase';
import { renderPdfToSlideImages } from '../pdfUtils';
import type {
  Participant,
  Question,
  Room,
  SharedExplainBoard,
  Stroke,
  StudentBoard,
  UserProfile,
} from '../types';
import {
  DuoCheckBadge,
  DuoCrossBadge,
  DuoGemIcon,
  playDuoSound,
} from './DuoIcons';
import {
  renderStrokesToDataUrl,
  WhiteboardCanvas,
  WhiteboardPreview,
} from './WhiteboardCanvas';

interface QuizArenaProps {
  room: Room;
  profile: UserProfile;
  participants: Participant[];
  isSupervisor: boolean;
}

export const QuizArena: React.FC<QuizArenaProps> = ({
  room,
  profile,
  participants,
  isSupervisor,
}) => {
  const [questions, setQuestions] = useState<Question[]>([]);
  const [boards, setBoards] = useState<StudentBoard[]>([]);

  // Supervisor private draft (never synced to Firestore until "أدرج السؤال" is clicked)
  const [composerTab, setComposerTab] = useState<'text' | 'board' | 'pdf'>('text');
  const [draftText, setDraftText] = useState('');
  const [draftImage, setDraftImage] = useState('');
  const [draftBoardStrokes, setDraftBoardStrokes] = useState<Stroke[]>([]);
  const [pdfPages, setPdfPages] = useState<string[]>([]);
  const [pdfFileName, setPdfFileName] = useState('');
  const [selectedPdfPage, setSelectedPdfPage] = useState<number>(1);
  const [pdfLoading, setPdfLoading] = useState(false);
  const [pdfProgress, setPdfProgress] = useState('');
  const [draftError, setDraftError] = useState<string | null>(null);
  const [insertingQuestion, setInsertingQuestion] = useState(false);

  // Explain Mode shared whiteboard state
  const [sharedBoardExists, setSharedBoardExists] = useState(false);
  const [sharedStrokes, setSharedStrokes] = useState<Stroke[]>([]);
  const [explainBusy, setExplainBusy] = useState(false);

  // Student local strokes & sync state
  const [localStrokes, setLocalStrokes] = useState<Stroke[]>([]);
  const [submittingBoard, setSubmittingBoard] = useState(false);

  // Modals (inline, never window.alert/confirm)
  const [zoomedImage, setZoomedImage] = useState<string | null>(null);
  const [inspectedBoard, setInspectedBoard] = useState<StudentBoard | null>(null);
  const [showEndConfirm, setShowEndConfirm] = useState(false);
  const [finishingRoom, setFinishingRoom] = useState(false);
  const [gradingBusy, setGradingBusy] = useState(false);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const pdfInputRef = useRef<HTMLInputElement | null>(null);

  // Subscribe to published questions in the room
  useEffect(() => {
    const qPath = `rooms/${room.id}/questions`;
    const qRef = query(collection(db, 'rooms', room.id, 'questions'), where('roomId', '==', room.id));
    const unsub = onSnapshot(
      qRef,
      (snap) => {
        const list: Question[] = [];
        snap.forEach((d) => list.push(d.data() as Question));
        list.sort((a, b) => a.orderIndex - b.orderIndex);
        setQuestions(list);
      },
      (err) => {
        handleFirestoreError(err, OperationType.LIST, qPath);
      }
    );
    return () => unsub();
  }, [room.id]);

  // Subscribe to synchronized Explain Mode shared whiteboard
  useEffect(() => {
    const sbPath = `rooms/${room.id}/sharedBoard/live`;
    const sbRef = doc(db, 'rooms', room.id, 'sharedBoard', 'live');
    const unsub = onSnapshot(
      sbRef,
      (snap) => {
        if (snap.exists()) {
          const data = snap.data() as SharedExplainBoard;
          setSharedBoardExists(true);
          setSharedStrokes(data.strokes || []);
        } else {
          setSharedBoardExists(false);
          setSharedStrokes([]);
        }
      },
      (err) => {
        handleFirestoreError(err, OperationType.GET, sbPath);
      }
    );
    return () => unsub();
  }, [room.id]);

  const currentQuestion = useMemo(() => {
    if (!room.currentQuestionId) return null;
    return questions.find((q) => q.id === room.currentQuestionId) ?? null;
  }, [questions, room.currentQuestionId]);

  // Subscribe to boards for the active question
  useEffect(() => {
    if (!currentQuestion) {
      setBoards([]);
      return;
    }
    const bPath = `rooms/${room.id}/questions/${currentQuestion.id}/boards`;
    const bRef = query(
      collection(db, 'rooms', room.id, 'questions', currentQuestion.id, 'boards'),
      where('roomId', '==', room.id),
      where('questionId', '==', currentQuestion.id)
    );
    const unsub = onSnapshot(
      bRef,
      (snap) => {
        const list: StudentBoard[] = [];
        snap.forEach((d) => list.push(d.data() as StudentBoard));
        setBoards(list);
      },
      (err) => {
        handleFirestoreError(err, OperationType.LIST, bPath);
      }
    );
    return () => unsub();
  }, [room.id, currentQuestion?.id]);

  // Reset local strokes when switching to a new question
  const myBoard = useMemo(
    () => boards.find((b) => b.studentId === profile.uid) ?? null,
    [boards, profile.uid]
  );

  useEffect(() => {
    if (!currentQuestion) {
      setLocalStrokes([]);
      return;
    }
    if (myBoard) {
      setLocalStrokes(myBoard.strokes || []);
    } else {
      setLocalStrokes([]);
    }
  }, [currentQuestion?.id, myBoard?.studentId]);

  // Sound feedback when question resolves
  const prevQStatusRef = useRef<string | null>(null);
  useEffect(() => {
    if (!currentQuestion) {
      prevQStatusRef.current = null;
      return;
    }
    if (prevQStatusRef.current === 'solving' && currentQuestion.status === 'correct') {
      playDuoSound('correct');
    } else if (prevQStatusRef.current === 'solving' && currentQuestion.status === 'unanswered') {
      playDuoSound('wrong');
    } else if (prevQStatusRef.current === null && currentQuestion.status === 'solving') {
      playDuoSound('pop');
    }
    prevQStatusRef.current = currentQuestion.status;
  }, [currentQuestion?.id, currentQuestion?.status]);

  // Pending submission queue ordered by server timestamp (first to press "تم" = الطالب الأول)
  const pendingQueue = useMemo(() => {
    return boards
      .filter((b) => b.submitted && b.verdict === 'pending')
      .sort((a, b) => getTimestampMillis(a.updatedAt) - getTimestampMillis(b.updatedAt));
  }, [boards]);

  const activeReviewBoard = pendingQueue[0] ?? null;

  // Supervisor: upload private question image
  const handleImagePick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setDraftError(null);
    try {
      const compressed = await compressImageToDataUrl(file);
      setDraftImage(compressed);
    } catch (err) {
      setDraftError(err instanceof Error ? err.message : 'تعذر تحميل الصورة');
    } finally {
      e.target.value = '';
    }
  };

  // Supervisor: upload private PDF and render pages locally (only chosen page is ever sent to Firestore)
  const handlePdfPick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;

    const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
    if (!isPdf) {
      setDraftError('يرجى اختيار ملف PDF صالح');
      return;
    }

    setDraftError(null);
    setPdfLoading(true);
    setPdfProgress('جاري قراءة صفحات ملف PDF...');
    try {
      const pages = await renderPdfToSlideImages(
        file,
        (current, total) => {
          setPdfProgress(`جاري تجهيز الصفحة ${current} من ${total} (محلياً لدى المشرف فقط)...`);
        },
        30
      );
      if (pages.length === 0) {
        setDraftError('لم يتم العثور على صفحات في هذا الملف');
        return;
      }
      setPdfPages(pages);
      setPdfFileName(file.name);
      setSelectedPdfPage(1);
      setComposerTab('pdf');
      playDuoSound('pop');
    } catch (err) {
      setDraftError(err instanceof Error ? err.message : 'تعذر قراءة ملف PDF');
    } finally {
      setPdfLoading(false);
      setPdfProgress('');
    }
  };

  // Supervisor: publish question to everyone (supports text, uploaded image, chosen PDF page, or supervisor's private whiteboard)
  const handleInsertQuestion = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isSupervisor || insertingQuestion) return;

    let finalImageData = '';
    if (composerTab === 'pdf' && pdfPages.length > 0) {
      finalImageData = pdfPages[selectedPdfPage - 1] ?? '';
    } else if (composerTab === 'board') {
      if (draftBoardStrokes.length > 0) {
        finalImageData = renderStrokesToDataUrl(draftBoardStrokes);
      } else if (draftImage) {
        finalImageData = draftImage;
      }
    } else {
      finalImageData = draftImage;
      if (!finalImageData && draftBoardStrokes.length > 0) {
        finalImageData = renderStrokesToDataUrl(draftBoardStrokes);
      }
    }

    if (!draftText.trim() && !finalImageData) {
      setDraftError(
        composerTab === 'pdf'
          ? 'ارفع ملف PDF وحدد الصفحة المطلوب إظهارها للطلاب أولاً'
          : 'اكتب نص السؤال، أو ارفع صورة أو صفحة PDF، أو ارسمه على سبورتك الخاصة قبل الإدراج'
      );
      return;
    }
    setDraftError(null);
    setInsertingQuestion(true);

    const newQId = `q_${Date.now()}`;
    const orderIndex = questions.length + 1;
    try {
      const batch = writeBatch(db);
      const qDocRef = doc(db, 'rooms', room.id, 'questions', newQId);
      batch.set(qDocRef, {
        id: newQId,
        roomId: room.id,
        orderIndex,
        text: draftText.trim().slice(0, 1000),
        imageData: finalImageData,
        status: 'solving',
        attemptsUsed: 0,
        wrongStudentIds: [],
        winnerId: '',
        winnerName: '',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      batch.update(doc(db, 'rooms', room.id), {
        currentQuestionId: newQId,
        questionCount: orderIndex,
        updatedAt: serverTimestamp(),
      });
      await batch.commit();
      setDraftText('');
      setDraftImage('');
      setDraftBoardStrokes([]);
      playDuoSound('pop');
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, `rooms/${room.id}/questions/${newQId}`);
    } finally {
      setInsertingQuestion(false);
    }
  };

  // Supervisor: toggle between Quiz Mode and Explain Mode
  const handleToggleExplainMode = async (nextMode: 'quiz' | 'explain') => {
    if (!isSupervisor || explainBusy) return;
    setExplainBusy(true);
    try {
      await updateDoc(doc(db, 'rooms', room.id), {
        mode: nextMode,
        explainPresenterId: profile.uid,
        explainPresenterName: profile.fullNameQuad,
        updatedAt: serverTimestamp(),
      });
      playDuoSound('pop');
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `rooms/${room.id}`);
    } finally {
      setExplainBusy(false);
    }
  };

  // Supervisor: assign who draws on the shared explain board
  const handleSelectPresenter = async (presenterId: string, presenterName: string) => {
    if (!isSupervisor || explainBusy) return;
    setExplainBusy(true);
    try {
      await updateDoc(doc(db, 'rooms', room.id), {
        mode: 'explain',
        explainPresenterId: presenterId,
        explainPresenterName: presenterName,
        updatedAt: serverTimestamp(),
      });
      playDuoSound('pop');
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `rooms/${room.id}`);
    } finally {
      setExplainBusy(false);
    }
  };

  // Active presenter (Supervisor or selected Student): sync shared explain board live
  const handleSharedStrokesChange = async (nextStrokes: Stroke[]) => {
    const canDraw =
      isSupervisor ||
      (room.mode === 'explain' && room.explainPresenterId === profile.uid);
    if (!canDraw) return;

    setSharedStrokes(nextStrokes);
    const sbPath = `rooms/${room.id}/sharedBoard/live`;
    const sbRef = doc(db, 'rooms', room.id, 'sharedBoard', 'live');
    try {
      if (!sharedBoardExists) {
        await setDoc(sbRef, {
          roomId: room.id,
          strokes: nextStrokes,
          updatedBy: profile.uid,
          updatedByName: profile.fullNameQuad,
          updatedAt: serverTimestamp(),
        });
      } else {
        await updateDoc(sbRef, {
          strokes: nextStrokes,
          updatedBy: profile.uid,
          updatedByName: profile.fullNameQuad,
          updatedAt: serverTimestamp(),
        });
      }
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, sbPath);
    }
  };

  // Student: save board strokes live
  const syncStudentBoard = async (strokes: Stroke[], submitted: boolean) => {
    if (!currentQuestion || isSupervisor) return;
    const boardRef = doc(
      db,
      'rooms',
      room.id,
      'questions',
      currentQuestion.id,
      'boards',
      profile.uid
    );
    const bPath = `rooms/${room.id}/questions/${currentQuestion.id}/boards/${profile.uid}`;

    try {
      if (!myBoard) {
        await setDoc(boardRef, {
          studentId: profile.uid,
          studentName: profile.fullNameQuad,
          roomId: room.id,
          questionId: currentQuestion.id,
          strokes,
          submitted,
          verdict: 'pending',
          updatedAt: serverTimestamp(),
        });
      } else {
        await updateDoc(boardRef, {
          strokes,
          submitted,
          updatedAt: serverTimestamp(),
        });
      }
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, bPath);
    }
  };

  const handleStrokesChange = (next: Stroke[]) => {
    setLocalStrokes(next);
    if (!currentQuestion || currentQuestion.status !== 'solving') return;
    if (myBoard?.submitted || myBoard?.verdict === 'wrong') return;
    void syncStudentBoard(next, false);
  };

  const handleStudentSubmit = async () => {
    if (!currentQuestion || submittingBoard || isSupervisor) return;
    setSubmittingBoard(true);
    try {
      await syncStudentBoard(localStrokes, true);
      playDuoSound('pop');
    } finally {
      setSubmittingBoard(false);
    }
  };

  // Supervisor: grade submitted board ("صح" or "غلط")
  const handleGradeBoard = async (board: StudentBoard, isCorrect: boolean) => {
    if (!currentQuestion || !isSupervisor || gradingBusy) return;
    setGradingBusy(true);

    try {
      const batch = writeBatch(db);
      const boardRef = doc(
        db,
        'rooms',
        room.id,
        'questions',
        currentQuestion.id,
        'boards',
        board.studentId
      );
      const qRef = doc(db, 'rooms', room.id, 'questions', currentQuestion.id);

      if (isCorrect) {
        batch.update(boardRef, {
          verdict: 'correct',
          updatedAt: serverTimestamp(),
        });
        batch.update(qRef, {
          status: 'correct',
          winnerId: board.studentId,
          winnerName: board.studentName,
          updatedAt: serverTimestamp(),
        });
        const targetPart = participants.find((p) => p.uid === board.studentId);
        if (targetPart) {
          batch.update(doc(db, 'rooms', room.id, 'participants', board.studentId), {
            score: (targetPart.score || 0) + 100,
            correctCount: (targetPart.correctCount || 0) + 1,
            updatedAt: serverTimestamp(),
          });
        }
        playDuoSound('correct');
      } else {
        batch.update(boardRef, {
          verdict: 'wrong',
          updatedAt: serverTimestamp(),
        });

        const nextWrongIds = Array.from(
          new Set([...(currentQuestion.wrongStudentIds || []), board.studentId])
        ).slice(0, 2);
        const nextAttempts = Math.min(2, (currentQuestion.attemptsUsed || 0) + 1);

        // If 1st student got it wrong AND there are at least 2 students in the room -> pass to 2nd student!
        const hasSecondStudent = participants.length >= 2 && nextAttempts === 1;

        if (hasSecondStudent) {
          batch.update(qRef, {
            attemptsUsed: 1,
            wrongStudentIds: nextWrongIds,
            updatedAt: serverTimestamp(),
          });
        } else {
          // 2nd student also got it wrong (or only 1 student) -> no one gets the point
          batch.update(qRef, {
            status: 'unanswered',
            attemptsUsed: nextAttempts,
            wrongStudentIds: nextWrongIds,
            updatedAt: serverTimestamp(),
          });
        }
        playDuoSound('wrong');
      }

      await batch.commit();
    } catch (err) {
      handleFirestoreError(
        err,
        OperationType.WRITE,
        `rooms/${room.id}/questions/${currentQuestion.id}`
      );
    } finally {
      setGradingBusy(false);
    }
  };

  // Supervisor: skip / close current question manually
  const handleCloseQuestionUnanswered = async () => {
    if (!currentQuestion || !isSupervisor || currentQuestion.status !== 'solving') return;
    setGradingBusy(true);
    try {
      await updateDoc(doc(db, 'rooms', room.id, 'questions', currentQuestion.id), {
        status: 'unanswered',
        attemptsUsed: currentQuestion.attemptsUsed || 0,
        wrongStudentIds: currentQuestion.wrongStudentIds || [],
        updatedAt: serverTimestamp(),
      });
      playDuoSound('pop');
    } catch (err) {
      handleFirestoreError(
        err,
        OperationType.UPDATE,
        `rooms/${room.id}/questions/${currentQuestion.id}`
      );
    } finally {
      setGradingBusy(false);
    }
  };

  // Supervisor: finish the whole test
  const handleFinishRoom = async () => {
    if (!isSupervisor || finishingRoom) return;
    setFinishingRoom(true);
    try {
      await updateDoc(doc(db, 'rooms', room.id), {
        status: 'finished',
        updatedAt: serverTimestamp(),
      });
      playDuoSound('finish');
      setShowEndConfirm(false);
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `rooms/${room.id}`);
    } finally {
      setFinishingRoom(false);
    }
  };

  // Determine student lock state
  const studentLockedInfo = useMemo(() => {
    if (!currentQuestion) {
      return {
        locked: true,
        title: 'السبورة مقفلة حالياً',
        subtitle: 'بانتظار المشرف لكتابة السؤال أو رفع الصورة والضغط على «أدرج السؤال»',
      };
    }
    if (currentQuestion.status === 'correct') {
      return {
        locked: true,
        title: `انتهى السؤال — أُحتسبت الإجابة للطالب ${currentQuestion.winnerName}`,
        subtitle: 'بانتظار المشرف لإدراج السؤال التالي أو إنهاء الاختبار',
      };
    }
    if (currentQuestion.status === 'unanswered') {
      return {
        locked: true,
        title: 'انتهت المحاولات — لم تُحسب الإجابة لأحد',
        subtitle: 'بانتظار المشرف لإدراج السؤال التالي أو إنهاء الاختبار',
      };
    }
    if (
      currentQuestion.wrongStudentIds?.includes(profile.uid) ||
      myBoard?.verdict === 'wrong'
    ) {
      return {
        locked: true,
        title: 'إجابتك غير صحيحة',
        subtitle: 'تحوّل السؤال إلى الطالب الثاني للمحاولة الأخيرة',
      };
    }
    if (myBoard?.submitted) {
      return {
        locked: true,
        title: 'تم تسليم إجابتك للمشرف',
        subtitle: 'بانتظار تأكيد المشرف على صحة الإجابة',
      };
    }
    return { locked: false, title: '', subtitle: '' };
  }, [currentQuestion, myBoard?.submitted, myBoard?.verdict, profile.uid]);

  const isExplainMode = room.mode === 'explain';
  const canDrawOnSharedBoard =
    isSupervisor || (isExplainMode && room.explainPresenterId === profile.uid);
  const currentPresenterName = room.explainPresenterName || room.supervisorName;

  const myParticipant = participants.find((p) => p.uid === profile.uid);
  const progressPercent = currentQuestion
    ? currentQuestion.status === 'solving'
      ? 65
      : 100
    : 15;

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 py-5 flex flex-col gap-5">
      {/* Arena Top Strip */}
      <div className="duo-card p-4 flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-4 flex-1 min-w-[220px]">
          <div className="flex flex-col">
            <span className="text-xs font-extrabold text-[#777777]">
              رمز الغرفة:{' '}
              <span className="font-latin text-[#1CB0F6] font-black">{room.id}</span>
            </span>
            <span className="text-base font-black text-[#3C3C3C]">
              {isExplainMode
                ? 'وضع الشرح التفاعلي المباشر'
                : currentQuestion
                ? `السؤال رقم ${currentQuestion.orderIndex}`
                : 'بانتظار إدراج السؤال الأول'}
            </span>
          </div>

          {/* Iconic Duolingo Glossy Progress Bar */}
          <div className="hidden sm:block flex-1 max-w-md h-4 bg-[#E5E5E5] rounded-full overflow-hidden">
            <div
              className={`duo-progress-fill h-full rounded-full ${
                isExplainMode ? 'bg-[#1CB0F6]' : 'bg-[#58CC02]'
              }`}
              style={{ width: isExplainMode ? '100%' : `${progressPercent}%` }}
            />
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          {!isSupervisor && (
            <div className="flex items-center gap-2 px-4 py-2 rounded-xl bg-[#DDF4FF] border-2 border-[#1CB0F6]">
              <DuoGemIcon className="w-5 h-5" />
              <span className="font-latin text-base font-black text-[#1899D6]">
                {myParticipant?.score ?? 0}
              </span>
              <span className="text-xs font-extrabold text-[#1899D6]">نقطة</span>
            </div>
          )}

          {isSupervisor && (
            <>
              {isExplainMode ? (
                <button
                  type="button"
                  disabled={explainBusy}
                  onClick={() => handleToggleExplainMode('quiz')}
                  className="duo-btn flex items-center gap-2 px-5 py-2.5 rounded-2xl bg-[#58CC02] hover:bg-[#61E002] border-2 border-[#46A302] border-b-4 text-white text-sm font-black cursor-pointer whitespace-nowrap disabled:opacity-60"
                >
                  <ArrowRight className="w-4 h-4" />
                  <span>العودة لوضع الأسئلة</span>
                </button>
              ) : (
                <button
                  type="button"
                  disabled={explainBusy}
                  onClick={() => handleToggleExplainMode('explain')}
                  className="duo-btn flex items-center gap-2 px-5 py-2.5 rounded-2xl bg-[#1CB0F6] hover:bg-[#33BCFF] border-2 border-[#1899D6] border-b-4 text-white text-sm font-black cursor-pointer whitespace-nowrap disabled:opacity-60"
                >
                  <Presentation className="w-4 h-4" />
                  <span>شرح (سبورة جماعية)</span>
                </button>
              )}

              <button
                type="button"
                onClick={() => setShowEndConfirm(true)}
                className="duo-btn flex items-center gap-2 px-5 py-2.5 rounded-2xl bg-[#FF4B4B] hover:bg-[#FF6161] border-2 border-[#EA2B2B] border-b-4 text-white text-sm font-black cursor-pointer whitespace-nowrap"
              >
                <Flag className="w-4 h-4" />
                <span>إنهاء الاختبار</span>
              </button>
            </>
          )}
        </div>
      </div>

      {/* ==================== EXPLAIN MODE (SHARED SYNCHRONIZED BOARD) ==================== */}
      {isExplainMode ? (
        <div className="flex flex-col gap-5">
          {/* Explain Mode Status & Presenter Assignment Card */}
          <div className="duo-card p-5 sm:p-6 bg-[#DDF4FF]/45 border-[#1CB0F6] flex flex-col gap-4">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div className="flex items-center gap-3">
                <div className="w-11 h-11 rounded-2xl bg-[#1CB0F6] text-white flex items-center justify-center shrink-0">
                  <Presentation className="w-6 h-6" />
                </div>
                <div>
                  <span className="text-xs font-extrabold text-[#1899D6] block">
                    السبورة الجماعية المتزامنة للجميع
                  </span>
                  <h2 className="text-xl font-black text-[#3C3C3C]">
                    يشرح الآن: {currentPresenterName}
                  </h2>
                </div>
              </div>

              {!isSupervisor && room.explainPresenterId === profile.uid && (
                <span className="px-4 py-2 rounded-xl bg-[#D7FFB8] border-2 border-[#58CC02] text-[#46A302] text-sm font-black">
                  أنت تملك القلم الآن — ارسم وسيظهر شرحك للجميع
                </span>
              )}

              {isSupervisor && sharedStrokes.length > 0 && (
                <button
                  type="button"
                  onClick={() => void handleSharedStrokesChange([])}
                  className="duo-btn flex items-center gap-1.5 px-4 py-2 rounded-xl bg-white border-2 border-b-4 border-[#E5E5E5] text-xs font-black text-[#EA2B2B] hover:bg-[#FFDFE0] cursor-pointer"
                >
                  <Trash2 className="w-4 h-4" />
                  <span>مسح سبورة الشرح للجميع</span>
                </button>
              )}
            </div>

            {/* Supervisor Presenter Picker (Supervisor or Any Student) */}
            {isSupervisor && (
              <div className="pt-3 border-t-2 border-[#BCE8FF] flex flex-col gap-2.5">
                <div className="flex items-center gap-2 text-xs font-extrabold text-[#1899D6]">
                  <Users className="w-4 h-4" />
                  <span>اختر من يكتب ويشرح على السبورة الآن (المشرف أو أحد الطلاب):</span>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    disabled={explainBusy}
                    onClick={() => handleSelectPresenter(profile.uid, profile.fullNameQuad)}
                    className={`duo-btn px-4 py-2 rounded-xl border-2 border-b-4 text-xs font-black cursor-pointer whitespace-nowrap ${
                      room.explainPresenterId === profile.uid
                        ? 'bg-[#58CC02] border-[#46A302] text-white'
                        : 'bg-white border-[#E5E5E5] text-[#3C3C3C] hover:bg-[#F7F7F7]'
                    }`}
                  >
                    المشرف (أنت)
                  </button>

                  {participants.map((p) => {
                    const active = room.explainPresenterId === p.uid;
                    return (
                      <button
                        key={p.uid}
                        type="button"
                        disabled={explainBusy}
                        onClick={() => handleSelectPresenter(p.uid, p.fullNameQuad)}
                        className={`duo-btn px-4 py-2 rounded-xl border-2 border-b-4 text-xs font-black cursor-pointer whitespace-nowrap ${
                          active
                            ? 'bg-[#FFC800] border-[#E5A400] text-[#3C3C3C]'
                            : 'bg-white border-[#E5E5E5] text-[#3C3C3C] hover:bg-[#F7F7F7]'
                        }`}
                      >
                        {p.fullNameQuad}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>

          {/* Synchronized Explain Whiteboard */}
          <WhiteboardCanvas
            strokes={sharedStrokes}
            onStrokesChange={(next) => void handleSharedStrokesChange(next)}
            viewOnly={!canDrawOnSharedBoard}
            syncIntervalMs={220}
            heightClass="h-[460px] md:h-[560px]"
          />
        </div>
      ) : (
        <>

      {/* Active Question Banner (Visible to everyone ONLY after supervisor inserts it) */}
      {currentQuestion ? (
        <div
          className={`duo-card p-5 sm:p-6 flex flex-col gap-4 ${
            currentQuestion.status === 'correct'
              ? 'bg-[#D7FFB8]/45 border-[#58CC02]'
              : currentQuestion.status === 'unanswered'
              ? 'bg-[#FFDFE0]/45 border-[#FF4B4B]'
              : 'bg-white'
          }`}
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2.5">
              <span className="font-latin px-3 py-1 rounded-xl bg-[#1CB0F6] text-white text-sm font-black">
                س{currentQuestion.orderIndex}
              </span>
              {currentQuestion.status === 'solving' && (
                <span className="text-sm font-black text-[#1899D6]">
                  {currentQuestion.attemptsUsed === 0
                    ? 'جاري الحل — أسرع طالب يضغط «تم» أولاً!'
                    : 'أخطأ الطالب الأول — تحوّل السؤال الآن للطالب الثاني!'}
                </span>
              )}
              {currentQuestion.status === 'correct' && (
                <div className="flex items-center gap-2 text-[#46A302]">
                  <DuoCheckBadge className="w-6 h-6" />
                  <span className="text-base font-black">
                    إجابة صحيحة! أُحتسب السؤال للطالب: {currentQuestion.winnerName}
                  </span>
                </div>
              )}
              {currentQuestion.status === 'unanswered' && (
                <div className="flex items-center gap-2 text-[#EA2B2B]">
                  <DuoCrossBadge className="w-6 h-6" />
                  <span className="text-base font-black">
                    انتهت المحاولتان — لم تُحسب الإجابة لأحد
                  </span>
                </div>
              )}
            </div>

            {isSupervisor && currentQuestion.status === 'solving' && (
              <button
                type="button"
                disabled={gradingBusy}
                onClick={handleCloseQuestionUnanswered}
                className="duo-btn flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-white border-2 border-b-4 border-[#E5E5E5] text-xs font-extrabold text-[#777777] hover:text-[#3C3C3C] cursor-pointer"
              >
                <SkipForward className="w-4 h-4" />
                <span>تخطي السؤال</span>
              </button>
            )}
          </div>

          <div className="flex flex-col md:flex-row gap-4 items-start">
            {currentQuestion.text && (
              <p className="text-lg sm:text-xl font-black text-[#3C3C3C] leading-relaxed flex-1 whitespace-pre-wrap">
                {currentQuestion.text}
              </p>
            )}
            {currentQuestion.imageData && (
              <button
                type="button"
                onClick={() => setZoomedImage(currentQuestion.imageData)}
                className="group relative rounded-2xl overflow-hidden border-2 border-[#E5E5E5] bg-[#F7F7F7] max-w-md cursor-pointer shrink-0"
              >
                <img
                  src={currentQuestion.imageData}
                  alt="صورة السؤال"
                  className="max-h-64 w-auto object-contain"
                />
                <span className="absolute bottom-2 left-2 bg-black/70 text-white text-xs font-bold px-2.5 py-1 rounded-lg flex items-center gap-1">
                  <ZoomIn className="w-3.5 h-3.5" />
                  <span>تكبير الصفحة / الصورة</span>
                </span>
              </button>
            )}
          </div>
        </div>
      ) : (
        <div className="duo-card p-6 bg-[#F7F7F7] flex items-center justify-between gap-4">
          <div>
            <h2 className="text-lg font-black text-[#3C3C3C]">
              {isSupervisor
                ? 'أدرج السؤال الأول من لوحة الإعداد السرية أدناه'
                : 'الجميع في غرفة السبورة — بانتظار المشرف لإدراج السؤال الأول'}
            </h2>
            <p className="text-sm font-bold text-[#777777]">
              {isSupervisor
                ? 'لن يرى الطلاب نص السؤال أو صورته أثناء كتابتك حتى تضغط «أدرج السؤال للجميع»'
                : 'لا يمكنك الكتابة على السبورة إلا بعد أن يُدرج المشرف السؤال'}
            </p>
          </div>
        </div>
      )}

      {/* ==================== SUPERVISOR VIEW ==================== */}
      {isSupervisor ? (
        <div className="flex flex-col gap-6">
          {/* Pending Submission Spotlight (Student 1 -> Student 2 Review) */}
          {currentQuestion && currentQuestion.status === 'solving' && activeReviewBoard && (
            <div className="duo-card p-5 sm:p-6 border-[#FFC800] bg-[#FFF4CC]/55 flex flex-col gap-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-2.5">
                  <Sparkles className="w-6 h-6 text-[#E5A400]" />
                  <div>
                    <span className="text-xs font-extrabold text-[#B88200] block">
                      {currentQuestion.attemptsUsed === 0
                        ? 'المحاولة الأولى (الطالب الأول)'
                        : 'المحاولة الثانية (تحوّل السؤال للطالب الثاني)'}
                    </span>
                    <h3 className="text-xl font-black text-[#3C3C3C]">
                      أتمّ الطالب: {activeReviewBoard.studentName}
                    </h3>
                  </div>
                </div>

                {pendingQueue.length > 1 && (
                  <span className="text-xs font-extrabold text-[#777777]">
                    في الانتظار بعده: {pendingQueue.length - 1} طالب
                  </span>
                )}
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-3 gap-5 items-center">
                <div className="lg:col-span-2">
                  <WhiteboardPreview
                    strokes={activeReviewBoard.strokes || []}
                    className="w-full aspect-[12/7]"
                  />
                </div>
                <div className="flex flex-col gap-3">
                  <p className="text-sm font-bold text-[#3C3C3C]">
                    تحقق من حل الطالب على السبورة ثم اعتمد النتيجة:
                  </p>
                  <button
                    type="button"
                    disabled={gradingBusy}
                    onClick={() => handleGradeBoard(activeReviewBoard, true)}
                    className="duo-btn w-full flex items-center justify-center gap-2 px-6 py-4 rounded-2xl bg-[#58CC02] hover:bg-[#61E002] border-2 border-[#46A302] border-b-[5px] text-white text-lg font-black cursor-pointer disabled:opacity-60"
                  >
                    <Check className="w-6 h-6 stroke-[3]" />
                    <span>إجابة صحيحة (صح)</span>
                  </button>
                  <button
                    type="button"
                    disabled={gradingBusy}
                    onClick={() => handleGradeBoard(activeReviewBoard, false)}
                    className="duo-btn w-full flex items-center justify-center gap-2 px-6 py-4 rounded-2xl bg-[#FF4B4B] hover:bg-[#FF6161] border-2 border-[#EA2B2B] border-b-[5px] text-white text-lg font-black cursor-pointer disabled:opacity-60"
                  >
                    <X className="w-6 h-6 stroke-[3]" />
                    <span>
                      {currentQuestion.attemptsUsed === 0 && participants.length >= 2
                        ? 'إجابة خاطئة (تحويل للثاني)'
                        : 'إجابة خاطئة (غلط)'}
                    </span>
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Private Supervisor Question Composer (Invisible to Students until Inserted) */}
          {(!currentQuestion || currentQuestion.status !== 'solving') && (
            <form
              onSubmit={handleInsertQuestion}
              className="duo-card p-5 sm:p-6 flex flex-col gap-4 border-[#1CB0F6]"
            >
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <EyeOff className="w-5 h-5 text-[#1899D6]" />
                  <h3 className="text-lg font-black text-[#3C3C3C]">
                    إعداد السؤال {questions.length + 1} (خاص بالمشرف فقط)
                  </h3>
                </div>

                {/* Mode Tabs: Text/Image, PDF Page Picker, OR Supervisor's Private Whiteboard */}
                <div className="flex flex-wrap items-center gap-1 p-1 bg-[#F7F7F7] border-2 border-[#E5E5E5] rounded-xl">
                  <button
                    type="button"
                    onClick={() => setComposerTab('text')}
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-black transition-colors cursor-pointer whitespace-nowrap ${
                      composerTab === 'text'
                        ? 'bg-white text-[#1899D6] shadow-sm'
                        : 'text-[#777777] hover:text-[#3C3C3C]'
                    }`}
                  >
                    <Type className="w-3.5 h-3.5" />
                    <span>كتابة نص / صورة</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setComposerTab('pdf')}
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-black transition-colors cursor-pointer whitespace-nowrap ${
                      composerTab === 'pdf'
                        ? 'bg-white text-[#9A6B00] shadow-sm'
                        : 'text-[#777777] hover:text-[#3C3C3C]'
                    }`}
                  >
                    <FileText className="w-3.5 h-3.5" />
                    <span>
                      {pdfPages.length > 0
                        ? `صفحة من PDF (${pdfPages.length})`
                        : 'تحديد صفحة من PDF'}
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setComposerTab('board')}
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-black transition-colors cursor-pointer whitespace-nowrap ${
                      composerTab === 'board'
                        ? 'bg-white text-[#46A302] shadow-sm'
                        : 'text-[#777777] hover:text-[#3C3C3C]'
                    }`}
                  >
                    <PenTool className="w-3.5 h-3.5" />
                    <span>رسم على سبورة المشرف</span>
                  </button>
                </div>
              </div>

              {composerTab === 'text' ? (
                <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
                  <div className="lg:col-span-2 flex flex-col gap-2">
                    <label
                      htmlFor="question-draft-text"
                      className="text-xs font-extrabold text-[#3C3C3C]"
                    >
                      نص السؤال
                    </label>
                    <textarea
                      id="question-draft-text"
                      rows={3}
                      maxLength={1000}
                      value={draftText}
                      onChange={(e) => setDraftText(e.target.value)}
                      placeholder="اكتب سؤالك هنا... (أو اختر صفحة من ملف PDF أو ارسمه على سبورة المشرف)"
                      className="w-full px-4 py-3 rounded-2xl bg-[#F7F7F7] border-2 border-[#E5E5E5] focus:border-[#1CB0F6] focus:bg-white outline-none text-base font-bold text-[#3C3C3C] resize-none"
                    />
                  </div>

                  <div className="flex flex-col gap-2">
                    <span className="text-xs font-extrabold text-[#3C3C3C]">
                      صورة السؤال (اختياري)
                    </span>
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept="image/*"
                      onChange={handleImagePick}
                      className="hidden"
                    />
                    {draftImage ? (
                      <div className="relative rounded-2xl border-2 border-[#E5E5E5] bg-[#F7F7F7] p-2 flex items-center justify-center h-28">
                        <img
                          src={draftImage}
                          alt="معاينة الصورة"
                          className="max-h-full max-w-full object-contain rounded-lg"
                        />
                        <button
                          type="button"
                          onClick={() => setDraftImage('')}
                          className="absolute top-2 left-2 p-1.5 rounded-lg bg-[#FF4B4B] text-white cursor-pointer"
                          title="حذف الصورة"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={() => fileInputRef.current?.click()}
                        className="duo-btn h-28 rounded-2xl border-2 border-dashed border-[#1CB0F6] bg-[#DDF4FF]/40 hover:bg-[#DDF4FF] flex flex-col items-center justify-center gap-2 text-[#1899D6] font-extrabold text-sm cursor-pointer"
                      >
                        <ImagePlus className="w-6 h-6" />
                        <span>رفع صورة من جهازك</span>
                      </button>
                    )}
                  </div>
                </div>
              ) : composerTab === 'pdf' ? (
                <div className="flex flex-col gap-4">
                  <input
                    ref={pdfInputRef}
                    type="file"
                    accept="application/pdf"
                    onChange={handlePdfPick}
                    className="hidden"
                  />

                  {pdfLoading ? (
                    <div className="p-8 rounded-2xl bg-[#FFF4CC]/60 border-2 border-[#FFC800] text-center text-sm font-black text-[#9A6B00]">
                      {pdfProgress || 'جاري تجهيز صفحات ملف PDF...'}
                    </div>
                  ) : pdfPages.length === 0 ? (
                    <button
                      type="button"
                      onClick={() => pdfInputRef.current?.click()}
                      className="duo-btn py-10 px-6 rounded-2xl border-2 border-dashed border-[#FFC800] bg-[#FFF4CC]/40 hover:bg-[#FFF4CC]/75 flex flex-col items-center justify-center gap-2.5 text-[#9A6B00] cursor-pointer"
                    >
                      <FileText className="w-9 h-9" />
                      <span className="text-base font-black">
                        ارفع ملف PDF خاص بك لتحديد صفحة واحدة وإظهارها للطلاب
                      </span>
                      <span className="text-xs font-bold text-[#777777]">
                        لا يظهر الملف للطلاب نهائياً — تظهر فقط الصفحة التي تحددها وتضغط إظهارها
                      </span>
                    </button>
                  ) : (
                    <div className="flex flex-col gap-3 bg-[#F7F7F7] border-2 border-[#E5E5E5] rounded-2xl p-4">
                      {/* PDF Header & Page Picker */}
                      <div className="flex flex-wrap items-center justify-between gap-2 pb-3 border-b-2 border-[#E5E5E5]">
                        <div className="flex items-center gap-2 min-w-0">
                          <FileText className="w-4 h-4 text-[#9A6B00] shrink-0" />
                          <span className="text-xs font-black text-[#3C3C3C] truncate max-w-[220px]">
                            {pdfFileName}
                          </span>
                          <span className="font-latin text-xs font-extrabold text-[#777777]">
                            ({pdfPages.length} صفحة)
                          </span>
                        </div>

                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => pdfInputRef.current?.click()}
                            className="duo-btn px-3 py-1.5 rounded-xl bg-white border-2 border-b-3 border-[#E5E5E5] text-xs font-black text-[#1899D6] cursor-pointer"
                          >
                            تغيير ملف PDF
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setPdfPages([]);
                              setPdfFileName('');
                              setSelectedPdfPage(1);
                            }}
                            className="duo-btn px-3 py-1.5 rounded-xl bg-white border-2 border-b-3 border-[#E5E5E5] text-xs font-black text-[#EA2B2B] cursor-pointer"
                          >
                            إزالة
                          </button>
                        </div>
                      </div>

                      {/* Page Selector Strip */}
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            disabled={selectedPdfPage <= 1}
                            onClick={() => setSelectedPdfPage((p) => Math.max(1, p - 1))}
                            className="duo-btn flex items-center gap-1 px-3 py-1.5 rounded-xl bg-white border-2 border-b-3 border-[#E5E5E5] text-xs font-black text-[#3C3C3C] cursor-pointer disabled:opacity-40"
                          >
                            <ChevronRight className="w-4 h-4" />
                            <span>السابقة</span>
                          </button>
                          <span className="font-latin px-3 py-1 rounded-xl bg-[#FFC800] text-[#3C3C3C] text-xs font-black">
                            الصفحة المحددة: {selectedPdfPage} / {pdfPages.length}
                          </span>
                          <button
                            type="button"
                            disabled={selectedPdfPage >= pdfPages.length}
                            onClick={() =>
                              setSelectedPdfPage((p) => Math.min(pdfPages.length, p + 1))
                            }
                            className="duo-btn flex items-center gap-1 px-3 py-1.5 rounded-xl bg-white border-2 border-b-3 border-[#E5E5E5] text-xs font-black text-[#3C3C3C] cursor-pointer disabled:opacity-40"
                          >
                            <span>التالية</span>
                            <ChevronLeft className="w-4 h-4" />
                          </button>
                        </div>

                        <div className="flex items-center gap-1.5 overflow-x-auto max-w-full py-1">
                          {pdfPages.map((_, idx) => {
                            const pageNum = idx + 1;
                            return (
                              <button
                                key={pageNum}
                                type="button"
                                onClick={() => setSelectedPdfPage(pageNum)}
                                className={`font-latin min-w-[30px] h-7 px-2 rounded-lg text-xs font-black cursor-pointer shrink-0 ${
                                  selectedPdfPage === pageNum
                                    ? 'bg-[#1CB0F6] text-white border-2 border-[#1899D6]'
                                    : 'bg-white text-[#777777] border border-[#E5E5E5] hover:text-[#3C3C3C]'
                                }`}
                              >
                                {pageNum}
                              </button>
                            );
                          })}
                        </div>
                      </div>

                      {/* Optional Note + Private Preview of Selected Page */}
                      <input
                        type="text"
                        maxLength={1000}
                        value={draftText}
                        onChange={(e) => setDraftText(e.target.value)}
                        placeholder={`ملاحظة أو عنوان للطلاب مع الصفحة ${selectedPdfPage} (اختياري، مثال: حل التمرين رقم 2)...`}
                        className="w-full px-4 py-2.5 rounded-2xl bg-white border-2 border-[#E5E5E5] focus:border-[#1CB0F6] outline-none text-sm font-bold text-[#3C3C3C]"
                      />

                      <div className="rounded-2xl border-2 border-[#E5E5E5] bg-white p-2 flex items-center justify-center max-h-[340px] overflow-hidden">
                        <img
                          src={pdfPages[selectedPdfPage - 1]}
                          alt={`معاينة صفحة ${selectedPdfPage}`}
                          className="max-h-[315px] w-auto object-contain rounded-lg"
                        />
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                <div className="flex flex-col gap-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-xs font-extrabold text-[#46A302]">
                      اكتب أو ارسم سؤالك على سبورتك السرية هنا (لا يراه الطلاب إلا بعد الضغط على «أدرج السؤال»)
                    </span>
                    {draftImage && (
                      <span className="text-xs font-bold text-[#777777]">
                        ملاحظة: توجد صورة مرفوعة — احذفها إذا أردت اعتماد رسم السبورة كصورة للسؤال
                      </span>
                    )}
                  </div>

                  <input
                    type="text"
                    maxLength={1000}
                    value={draftText}
                    onChange={(e) => setDraftText(e.target.value)}
                    placeholder="عنوان أو نص مختصر للسؤال (اختياري)..."
                    className="w-full px-4 py-2.5 rounded-2xl bg-[#F7F7F7] border-2 border-[#E5E5E5] focus:border-[#58CC02] focus:bg-white outline-none text-sm font-bold text-[#3C3C3C]"
                  />

                  <WhiteboardCanvas
                    strokes={draftBoardStrokes}
                    onStrokesChange={setDraftBoardStrokes}
                    heightClass="h-[340px] md:h-[400px]"
                  />
                </div>
              )}

              {draftError && (
                <p className="text-sm font-extrabold text-[#EA2B2B]">{draftError}</p>
              )}

              <div className="flex flex-wrap items-center justify-between gap-3">
                <span className="text-xs font-bold text-[#777777]">
                  {composerTab === 'pdf' && pdfPages.length > 0
                    ? `ستظهر الصفحة رقم ${selectedPdfPage} فقط للطلاب ليبدأوا الحل على سبوراتهم`
                    : draftBoardStrokes.length > 0 && !draftImage
                    ? 'سيتم إرفاق رسم سبورتك الخاصة مع السؤال تلقائياً'
                    : 'لا يظهر للطلاب أي شيء حتى تضغط زر الإدراج'}
                </span>
                <button
                  type="submit"
                  disabled={insertingQuestion || pdfLoading}
                  className="duo-btn flex items-center gap-2.5 px-8 py-3.5 rounded-2xl bg-[#58CC02] hover:bg-[#61E002] border-2 border-[#46A302] border-b-[5px] text-white text-base font-black cursor-pointer disabled:opacity-60"
                >
                  {composerTab === 'pdf' && pdfPages.length > 0 ? (
                    <Eye className="w-5 h-5" />
                  ) : (
                    <Send className="w-5 h-5" />
                  )}
                  <span>
                    {insertingQuestion
                      ? 'جاري النشر...'
                      : composerTab === 'pdf' && pdfPages.length > 0
                      ? `إظهار صفحة ${selectedPdfPage} وإدراجها للجميع`
                      : 'أدرج السؤال للجميع'}
                  </span>
                </button>
              </div>
            </form>
          )}

          {/* Live Students Whiteboards Grid */}
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-black text-[#3C3C3C]">
                سبورات الطلاب المباشرة ({participants.length})
              </h3>
              <span className="text-xs font-bold text-[#777777]">
                اضغط على أي سبورة لتكبيرها ومتابعة الحل
              </span>
            </div>

            {participants.length === 0 ? (
              <div className="duo-card p-8 text-center text-sm font-bold text-[#777777]">
                لا يوجد طلاب في الغرفة حالياً. شارك رمز الغرفة{' '}
                <span className="font-latin text-[#1CB0F6] font-black">{room.id}</span>
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                {participants.map((p) => {
                  const board = boards.find((b) => b.studentId === p.uid);
                  const verdict = board?.verdict;
                  const submitted = board?.submitted;
                  return (
                    <div
                      key={p.uid}
                      className={`duo-card p-4 flex flex-col gap-3 ${
                        verdict === 'correct'
                          ? 'border-[#58CC02] bg-[#D7FFB8]/30'
                          : verdict === 'wrong'
                          ? 'border-[#FF4B4B] bg-[#FFDFE0]/30'
                          : submitted
                          ? 'border-[#FFC800] bg-[#FFF4CC]/30'
                          : ''
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="min-w-0">
                          <p className="text-sm font-black text-[#3C3C3C] truncate">
                            {p.fullNameQuad}
                          </p>
                          <p className="text-xs font-bold text-[#777777]">
                            النقاط:{' '}
                            <span className="font-latin font-black text-[#1CB0F6]">
                              {p.score}
                            </span>
                            {' · '}
                            {verdict === 'correct'
                              ? 'إجابة صحيحة'
                              : verdict === 'wrong'
                              ? 'إجابة خاطئة'
                              : submitted
                              ? 'ضغط تم (بانتظار التأكيد)'
                              : board && board.strokes.length > 0
                              ? 'يكتب على السبورة الآن'
                              : 'لم يبدأ الكتابة'}
                          </p>
                        </div>

                        <button
                          type="button"
                          onClick={() =>
                            setInspectedBoard(
                              board ?? {
                                studentId: p.uid,
                                studentName: p.fullNameQuad,
                                roomId: room.id,
                                questionId: currentQuestion?.id || '',
                                strokes: [],
                                submitted: false,
                                verdict: 'pending',
                              }
                            )
                          }
                          className="p-2 rounded-xl bg-[#F7F7F7] hover:bg-[#DDF4FF] text-[#3C3C3C] hover:text-[#1899D6] cursor-pointer shrink-0"
                          title="تكبير السبورة"
                        >
                          <ZoomIn className="w-4 h-4" />
                        </button>
                      </div>

                      <WhiteboardPreview
                        strokes={board?.strokes || []}
                        emptyText={
                          currentQuestion ? 'لم يكتب الطالب بعد' : 'بانتظار السؤال'
                        }
                      />
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      ) : (
        /* ==================== STUDENT VIEW ==================== */
        <div className="flex flex-col gap-4">
          <WhiteboardCanvas
            strokes={localStrokes}
            onStrokesChange={handleStrokesChange}
            disabled={studentLockedInfo.locked}
            lockTitle={studentLockedInfo.title}
            lockSubtitle={studentLockedInfo.subtitle}
          />

          {/* Student Submit ("تم") Action Bar */}
          <div className="duo-card p-4 flex flex-col sm:flex-row items-center justify-between gap-4">
            <div className="text-sm font-bold text-[#777777]">
              {!currentQuestion
                ? 'عند إدراج السؤال ستفتح سبورتك للحل فوراً.'
                : studentLockedInfo.locked
                ? studentLockedInfo.title
                : 'اكتب حلك على السبورة ثم اضغط «تم» لإرسال الإجابة للمشرف.'}
            </div>

            <button
              type="button"
              disabled={studentLockedInfo.locked || submittingBoard}
              onClick={handleStudentSubmit}
              className="duo-btn w-full sm:w-auto flex items-center justify-center gap-2.5 px-10 py-4 rounded-2xl bg-[#58CC02] hover:bg-[#61E002] border-2 border-[#46A302] border-b-[5px] text-white text-lg font-black cursor-pointer disabled:bg-[#E5E5E5] disabled:border-[#CFCFCF] disabled:text-[#AFAFAF] disabled:cursor-not-allowed whitespace-nowrap"
            >
              <Check className="w-6 h-6 stroke-[3]" />
              <span>{submittingBoard ? 'جاري الإرسال...' : 'تم — إرسال الحل'}</span>
            </button>
          </div>
        </div>
      )}
        </>
      )}

      {/* Zoomed Question Image Modal */}
      {zoomedImage && (
        <div
          className="fixed inset-0 z-50 bg-black/75 flex items-center justify-center p-4"
          onClick={() => setZoomedImage(null)}
        >
          <div
            className="bg-white rounded-3xl p-4 max-w-4xl w-full flex flex-col gap-3"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex justify-between items-center">
              <span className="font-black text-[#3C3C3C]">معاينة صورة السؤال</span>
              <button
                type="button"
                onClick={() => setZoomedImage(null)}
                className="p-2 rounded-xl bg-[#F7F7F7] hover:bg-[#FFDFE0] text-[#3C3C3C] cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <img
              src={zoomedImage}
              alt="صورة السؤال مكبرة"
              className="max-h-[75vh] w-auto mx-auto object-contain rounded-xl"
            />
          </div>
        </div>
      )}

      {/* Inspected Student Board Modal */}
      {inspectedBoard && (
        <div
          className="fixed inset-0 z-50 bg-black/75 flex items-center justify-center p-4"
          onClick={() => setInspectedBoard(null)}
        >
          <div
            className="bg-white rounded-3xl p-5 max-w-4xl w-full flex flex-col gap-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex justify-between items-center">
              <h3 className="text-lg font-black text-[#3C3C3C]">
                سبورة الطالب: {inspectedBoard.studentName}
              </h3>
              <button
                type="button"
                onClick={() => setInspectedBoard(null)}
                className="p-2 rounded-xl bg-[#F7F7F7] hover:bg-[#FFDFE0] text-[#3C3C3C] cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <WhiteboardPreview
              strokes={inspectedBoard.strokes || []}
              className="w-full aspect-[12/7]"
            />
          </div>
        </div>
      )}

      {/* Finish Test Confirmation Modal */}
      {showEndConfirm && (
        <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4">
          <div className="duo-card max-w-md w-full p-6 flex flex-col gap-4 text-center">
            <h3 className="text-xl font-black text-[#3C3C3C]">
              هل تريد إنهاء الاختبار الآن؟
            </h3>
            <p className="text-sm font-bold text-[#777777]">
              سيتم عرض النتائج النهائية وجميع الأسئلة والصبورات للجميع، وحفظ الاختبار كاملاً في حساب كل مشرف وطالب.
            </p>
            <div className="flex items-center gap-3 pt-2">
              <button
                type="button"
                onClick={() => setShowEndConfirm(false)}
                className="duo-btn flex-1 py-3 rounded-2xl bg-white border-2 border-b-4 border-[#E5E5E5] text-sm font-black text-[#3C3C3C] cursor-pointer"
              >
                إلغاء
              </button>
              <button
                type="button"
                disabled={finishingRoom}
                onClick={handleFinishRoom}
                className="duo-btn flex-1 py-3 rounded-2xl bg-[#FF4B4B] border-2 border-b-4 border-[#EA2B2B] text-sm font-black text-white cursor-pointer disabled:opacity-60"
              >
                {finishingRoom ? 'جاري الإنهاء...' : 'تأكيد الإنهاء'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
