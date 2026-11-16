import React, { useState } from 'react';
import {
  doc,
  getDoc,
  serverTimestamp,
  setDoc,
  updateDoc,
} from 'firebase/firestore';
import { AlertCircle, ArrowLeft, Check, ClipboardCheck, Edit3, FileText, PlusCircle, X } from 'lucide-react';
import {
  db,
  generateRoomCode,
  handleFirestoreError,
  isQuadNameValid,
  OperationType,
} from '../firebase';
import type { SessionType, UserProfile } from '../types';
import { DUO_IMAGES, DuoArtwork, playDuoSound } from './DuoIcons';

interface RoleHubProps {
  profile: UserProfile;
  onProfileUpdated: (next: UserProfile) => void;
  onEnterRoom: (roomId: string, role: 'supervisor' | 'student') => void;
}

export const RoleHub: React.FC<RoleHubProps> = ({
  profile,
  onProfileUpdated,
  onEnterRoom,
}) => {
  const [sessionTitle, setSessionTitle] = useState('جلسة السبورة التفاعلية');
  const [sessionType, setSessionType] = useState<SessionType>('quiz');
  const [roomCodeInput, setRoomCodeInput] = useState('');
  const [studentNameConfirm, setStudentNameConfirm] = useState(profile.fullNameQuad);
  const [busyRole, setBusyRole] = useState<'supervisor' | 'student' | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const [editingName, setEditingName] = useState(false);
  const [editedName, setEditedName] = useState(profile.fullNameQuad);
  const [savingName, setSavingName] = useState(false);

  const handleSaveName = async () => {
    const cleaned = editedName.trim().replace(/\s+/g, ' ');
    if (!isQuadNameValid(cleaned)) {
      setErrorMsg('يرجى كتابة الاسم الرباعي من 4 كلمات على الأقل');
      return;
    }
    setSavingName(true);
    setErrorMsg(null);
    const path = `users/${profile.uid}/private/profile`;
    try {
      await updateDoc(doc(db, 'users', profile.uid, 'private', 'profile'), {
        fullNameQuad: cleaned,
        updatedAt: serverTimestamp(),
      });
      onProfileUpdated({ ...profile, fullNameQuad: cleaned });
      setStudentNameConfirm(cleaned);
      setEditingName(false);
      playDuoSound('pop');
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, path);
    } finally {
      setSavingName(false);
    }
  };

  const handleCreateSupervisorRoom = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);
    setBusyRole('supervisor');
    const title = sessionTitle.trim() || 'جلسة السبورة التفاعلية';

    try {
      let code = generateRoomCode();
      // Ensure room code is unused
      for (let attempt = 0; attempt < 4; attempt++) {
        const snap = await getDoc(doc(db, 'rooms', code));
        if (!snap.exists()) break;
        code = generateRoomCode();
      }

      const path = `rooms/${code}`;
      try {
        await setDoc(doc(db, 'rooms', code), {
          id: code,
          title: title.slice(0, 120),
          supervisorId: profile.uid,
          supervisorName: profile.fullNameQuad,
          status: 'waiting',
          sessionType,
          mode: 'quiz',
          explainPresenterId: profile.uid,
          explainPresenterName: profile.fullNameQuad,
          interactiveEditor: 'supervisor',
          interactiveEditorName: profile.fullNameQuad,
          currentSlideIndex: 0,
          slideCount: 0,
          currentQuestionId: '',
          questionCount: 0,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      } catch (err) {
        handleFirestoreError(err, OperationType.CREATE, path);
      }

      playDuoSound('join');
      onEnterRoom(code, 'supervisor');
    } catch (err) {
      setErrorMsg('تعذر إنشاء الغرفة، يرجى المحاولة مرة أخرى');
      console.error(err);
    } finally {
      setBusyRole(null);
    }
  };

  const handleJoinAsStudent = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);

    const code = roomCodeInput.trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '');
    if (code.length < 4 || code.length > 16) {
      setErrorMsg('يرجى إدخال رمز الغرفة الصحيح (6 أحرف أو أرقام)');
      return;
    }

    const cleanedName = studentNameConfirm.trim().replace(/\s+/g, ' ');
    if (!isQuadNameValid(cleanedName)) {
      setErrorMsg('يرجى كتابة اسمك الرباعي كاملاً (4 كلمات على الأقل) قبل الدخول');
      return;
    }

    setBusyRole('student');
    try {
      const roomRef = doc(db, 'rooms', code);
      let roomSnap;
      try {
        roomSnap = await getDoc(roomRef);
      } catch (err) {
        handleFirestoreError(err, OperationType.GET, `rooms/${code}`);
      }

      if (!roomSnap || !roomSnap.exists()) {
        setErrorMsg('لم يتم العثور على غرفة بهذا الرمز، تأكد من الرمز من المشرف');
        setBusyRole(null);
        return;
      }

      const roomData = roomSnap.data();
      if (roomData.status === 'finished') {
        setErrorMsg('انتهى الاختبار في هذه الغرفة بالفعل');
        setBusyRole(null);
        return;
      }

      if (roomData.supervisorId === profile.uid) {
        onEnterRoom(code, 'supervisor');
        return;
      }

      // Update saved profile name if user refined their quad name
      if (cleanedName !== profile.fullNameQuad) {
        await updateDoc(doc(db, 'users', profile.uid, 'private', 'profile'), {
          fullNameQuad: cleanedName,
          updatedAt: serverTimestamp(),
        });
        onProfileUpdated({ ...profile, fullNameQuad: cleanedName });
      }

      const participantRef = doc(db, 'rooms', code, 'participants', profile.uid);
      let existingPart;
      try {
        existingPart = await getDoc(participantRef);
      } catch (err) {
        handleFirestoreError(err, OperationType.GET, `rooms/${code}/participants/${profile.uid}`);
      }

      if (!existingPart || !existingPart.exists()) {
        try {
          await setDoc(participantRef, {
            uid: profile.uid,
            roomId: code,
            fullNameQuad: cleanedName,
            score: 0,
            correctCount: 0,
            joinedAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
        } catch (err) {
          handleFirestoreError(err, OperationType.CREATE, `rooms/${code}/participants/${profile.uid}`);
        }
      }

      playDuoSound('join');
      onEnterRoom(code, 'student');
    } catch (err) {
      setErrorMsg('حدث خطأ أثناء الانضمام للغرفة');
      console.error(err);
    } finally {
      setBusyRole(null);
    }
  };

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 py-8 flex flex-col gap-8">
      {/* Greeting & Quad Name Bar */}
      <div className="duo-card p-5 sm:p-6 flex flex-col sm:flex-row sm:items-center justify-between gap-4 bg-[#F7F7F7]">
        <div className="flex flex-col gap-1">
          <span className="text-xs font-extrabold text-[#777777]">مرحباً بك في منصة السبورة التفاعلية</span>
          {editingName ? (
            <div className="flex flex-wrap items-center gap-2 mt-1">
              <input
                type="text"
                value={editedName}
                onChange={(e) => setEditedName(e.target.value)}
                className="px-3 py-1.5 rounded-xl bg-white border-2 border-[#1CB0F6] text-base font-extrabold text-[#3C3C3C] outline-none min-w-[240px]"
              />
              <button
                type="button"
                disabled={savingName}
                onClick={handleSaveName}
                className="duo-btn p-2 rounded-xl bg-[#58CC02] border-2 border-b-4 border-[#46A302] text-white cursor-pointer"
                title="حفظ"
              >
                <Check className="w-4 h-4" />
              </button>
              <button
                type="button"
                onClick={() => {
                  setEditingName(false);
                  setEditedName(profile.fullNameQuad);
                }}
                className="duo-btn p-2 rounded-xl bg-white border-2 border-b-4 border-[#E5E5E5] text-[#777777] cursor-pointer"
                title="إلغاء"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-3">
              <h1 className="text-xl sm:text-2xl font-black text-[#3C3C3C]">
                {profile.fullNameQuad}
              </h1>
              <button
                type="button"
                onClick={() => setEditingName(true)}
                className="text-xs font-extrabold text-[#1CB0F6] hover:underline flex items-center gap-1 cursor-pointer whitespace-nowrap"
              >
                <Edit3 className="w-3.5 h-3.5" />
                <span>تعديل الاسم</span>
              </button>
            </div>
          )}
        </div>
        <div className="text-xs font-bold text-[#777777]">
          اختر دورك لإنشاء غرفة جديدة أو الانضمام برمز الغرفة
        </div>
      </div>

      {errorMsg && (
        <div className="flex items-center gap-3 p-4 rounded-2xl bg-[#FFDFE0] border-2 border-[#FF4B4B] text-[#EA2B2B] text-sm font-extrabold">
          <AlertCircle className="w-5 h-5 shrink-0" />
          <span>{errorMsg}</span>
        </div>
      )}

      {/* Two Main Role Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 items-stretch">
        {/* Supervisor Card */}
        <form
          onSubmit={handleCreateSupervisorRoom}
          className="duo-card p-6 sm:p-8 flex flex-col justify-between gap-6"
        >
          <div className="flex flex-col items-center text-center gap-4">
            <DuoArtwork
              src={DUO_IMAGES.supervisor}
              alt="شخصية المشرف"
              className="w-32 h-32"
            />
            <div>
              <h2 className="text-2xl font-black text-[#3C3C3C] mb-1">دخول كمشرف</h2>
              <p className="text-sm font-bold text-[#777777]">
                أنشئ غرفة اختبار، شارك رمز الغرفة مع الطلاب، وأدر الأسئلة والسبورات بالتزامن.
              </p>
            </div>
          </div>

          <div className="flex flex-col gap-4">
            {/* Session Type Picker: Quiz vs Interactive */}
            <div className="flex flex-col gap-2">
              <span className="text-xs font-extrabold text-[#3C3C3C]">
                اختر نوع الجلسة
              </span>
              <div className="grid grid-cols-2 gap-2.5">
                <button
                  type="button"
                  onClick={() => {
                    setSessionType('quiz');
                    playDuoSound('pop');
                  }}
                  className={`duo-btn flex flex-col items-center text-center gap-1.5 p-3 rounded-2xl border-2 border-b-4 transition-colors cursor-pointer ${
                    sessionType === 'quiz'
                      ? 'bg-[#D7FFB8] border-[#58CC02] text-[#3C3C3C]'
                      : 'bg-[#F7F7F7] border-[#E5E5E5] text-[#777777] hover:bg-white'
                  }`}
                >
                  <ClipboardCheck
                    className={`w-6 h-6 ${
                      sessionType === 'quiz' ? 'text-[#46A302]' : 'text-[#AFAFAF]'
                    }`}
                  />
                  <span className="text-sm font-black">اختبار</span>
                  <span className="text-[11px] font-bold leading-snug">
                    أسئلة وسبورات وتقييم وإجابات
                  </span>
                </button>

                <button
                  type="button"
                  onClick={() => {
                    setSessionType('interactive');
                    playDuoSound('pop');
                  }}
                  className={`duo-btn flex flex-col items-center text-center gap-1.5 p-3 rounded-2xl border-2 border-b-4 transition-colors cursor-pointer ${
                    sessionType === 'interactive'
                      ? 'bg-[#DDF4FF] border-[#1CB0F6] text-[#3C3C3C]'
                      : 'bg-[#F7F7F7] border-[#E5E5E5] text-[#777777] hover:bg-white'
                  }`}
                >
                  <FileText
                    className={`w-6 h-6 ${
                      sessionType === 'interactive' ? 'text-[#1899D6]' : 'text-[#AFAFAF]'
                    }`}
                  />
                  <span className="text-sm font-black">تفاعلي</span>
                  <span className="text-[11px] font-bold leading-snug">
                    رفع PDF أو صور والحل عليها بالتزامن
                  </span>
                </button>
              </div>
            </div>

            <div className="flex flex-col gap-1.5">
              <label
                htmlFor="session-title-input"
                className="text-xs font-extrabold text-[#3C3C3C]"
              >
                {sessionType === 'interactive' ? 'عنوان الجلسة التفاعلية' : 'عنوان الجلسة أو الاختبار'}
              </label>
              <input
                id="session-title-input"
                type="text"
                maxLength={100}
                value={sessionTitle}
                onChange={(e) => setSessionTitle(e.target.value)}
                placeholder={
                  sessionType === 'interactive'
                    ? 'مثال: شرح وحل ملزمة الرياضيات PDF'
                    : 'مثال: اختبار الرياضيات — المعادلات'
                }
                className="w-full px-4 py-3 rounded-2xl bg-[#F7F7F7] border-2 border-[#E5E5E5] focus:border-[#58CC02] focus:bg-white outline-none text-sm font-bold text-[#3C3C3C]"
              />
            </div>

            <button
              type="submit"
              disabled={busyRole !== null}
              className={`duo-btn w-full flex items-center justify-center gap-2.5 px-6 py-4 rounded-2xl border-2 border-b-[5px] text-white text-base font-black cursor-pointer disabled:opacity-60 ${
                sessionType === 'interactive'
                  ? 'bg-[#1CB0F6] hover:bg-[#33BCFF] border-[#1899D6]'
                  : 'bg-[#58CC02] hover:bg-[#61E002] border-[#46A302]'
              }`}
            >
              <PlusCircle className="w-5 h-5" />
              <span>
                {busyRole === 'supervisor'
                  ? 'جاري فتح غرفة الانتظار...'
                  : sessionType === 'interactive'
                  ? 'فتح غرفة انتظار (وضع تفاعلي)'
                  : 'فتح غرفة انتظار (وضع اختبار)'}
              </span>
            </button>
          </div>
        </form>

        {/* Student Card */}
        <form
          onSubmit={handleJoinAsStudent}
          className="duo-card p-6 sm:p-8 flex flex-col justify-between gap-6"
        >
          <div className="flex flex-col items-center text-center gap-4">
            <DuoArtwork
              src={DUO_IMAGES.student}
              alt="شخصية الطالب"
              className="w-32 h-32"
            />
            <div>
              <h2 className="text-2xl font-black text-[#3C3C3C] mb-1">دخول كطالب</h2>
              <p className="text-sm font-bold text-[#777777]">
                أدخل اسمك الرباعي ورمز الغرفة الذي يعطيك إياه المشرف للدخول إلى غرفة الانتظار مباشرة.
              </p>
            </div>
          </div>

          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <label
                htmlFor="student-quad-confirm"
                className="text-xs font-extrabold text-[#3C3C3C]"
              >
                اسمك الرباعي داخل الغرفة
              </label>
              <input
                id="student-quad-confirm"
                type="text"
                required
                value={studentNameConfirm}
                onChange={(e) => setStudentNameConfirm(e.target.value)}
                placeholder="الاسم الرباعي"
                className="w-full px-4 py-3 rounded-2xl bg-[#F7F7F7] border-2 border-[#E5E5E5] focus:border-[#1CB0F6] focus:bg-white outline-none text-sm font-bold text-[#3C3C3C]"
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <label
                htmlFor="room-code-input"
                className="text-xs font-extrabold text-[#3C3C3C]"
              >
                رمز الغرفة
              </label>
              <input
                id="room-code-input"
                type="text"
                required
                dir="ltr"
                value={roomCodeInput}
                onChange={(e) => setRoomCodeInput(e.target.value.toUpperCase())}
                placeholder="مثال: K7M4P9"
                maxLength={12}
                className="font-latin w-full px-4 py-3 rounded-2xl bg-[#F7F7F7] border-2 border-[#E5E5E5] focus:border-[#1CB0F6] focus:bg-white outline-none text-lg font-black tracking-[0.2em] text-center text-[#3C3C3C] uppercase"
              />
            </div>

            <button
              type="submit"
              disabled={busyRole !== null}
              className="duo-btn w-full flex items-center justify-center gap-2.5 px-6 py-4 rounded-2xl bg-[#1CB0F6] hover:bg-[#33BCFF] border-2 border-[#1899D6] border-b-[5px] text-white text-base font-black cursor-pointer disabled:opacity-60"
            >
              <span>
                {busyRole === 'student' ? 'جاري الدخول...' : 'دخول إلى الغرفة'}
              </span>
              <ArrowLeft className="w-5 h-5" />
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
