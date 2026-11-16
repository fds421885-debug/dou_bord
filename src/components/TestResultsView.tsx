import React, { useEffect, useState } from 'react';
import {
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  serverTimestamp,
  where,
  writeBatch,
} from 'firebase/firestore';
import { ArrowRight, CheckCircle2, X, ZoomIn } from 'lucide-react';
import { db, handleFirestoreError, OperationType } from '../firebase';
import type {
  Participant,
  ParticipantSummary,
  Question,
  Room,
  SavedBoardSnapshot,
  SavedQuestion,
  SavedTest,
  StudentBoard,
  UserProfile,
} from '../types';
import {
  DUO_IMAGES,
  DuoArtwork,
  DuoCheckBadge,
  DuoCrossBadge,
  DuoCrownIcon,
  DuoGemIcon,
} from './DuoIcons';
import { WhiteboardPreview } from './WhiteboardCanvas';

interface TestResultsViewProps {
  profile: UserProfile;
  // Either live finished room OR archived savedTest
  liveRoom?: Room;
  liveParticipants?: Participant[];
  isSupervisor?: boolean;
  archivedTest?: SavedTest;
  archivedQuestions?: SavedQuestion[];
  onBack: () => void;
}

export const TestResultsView: React.FC<TestResultsViewProps> = ({
  profile,
  liveRoom,
  liveParticipants = [],
  isSupervisor = false,
  archivedTest,
  archivedQuestions,
  onBack,
}) => {
  const [loading, setLoading] = useState<boolean>(Boolean(liveRoom));
  const [questionsData, setQuestionsData] = useState<SavedQuestion[]>(archivedQuestions ?? []);
  const [participantsData, setParticipantsData] = useState<ParticipantSummary[]>(
    archivedTest?.participantsSummary ?? []
  );
  const [savedNotice, setSavedNotice] = useState<boolean>(false);
  const [zoomedBoard, setZoomedBoard] = useState<SavedBoardSnapshot | null>(null);
  const [zoomedImg, setZoomedImg] = useState<string | null>(null);

  const title = liveRoom ? liveRoom.title : archivedTest?.title ?? 'نتائج الاختبار';
  const roomCode = liveRoom ? liveRoom.id : archivedTest?.roomCode ?? '';
  const supervisorName = liveRoom
    ? liveRoom.supervisorName
    : archivedTest?.supervisorName ?? '';

  useEffect(() => {
    if (!liveRoom) return;

    let cancelled = false;
    async function loadAndPersistLiveResults() {
      if (!liveRoom) return;
      setLoading(true);
      try {
        const qSnap = await getDocs(
          query(collection(db, 'rooms', liveRoom.id, 'questions'), where('roomId', '==', liveRoom.id))
        );
        const rawQuestions: Question[] = [];
        qSnap.forEach((d) => rawQuestions.push(d.data() as Question));
        rawQuestions.sort((a, b) => a.orderIndex - b.orderIndex);

        const assembledQuestions: SavedQuestion[] = [];
        for (const q of rawQuestions) {
          const bSnap = await getDocs(
            query(
              collection(db, 'rooms', liveRoom.id, 'questions', q.id, 'boards'),
              where('roomId', '==', liveRoom.id),
              where('questionId', '==', q.id)
            )
          );
          const boardMap = new Map<string, StudentBoard>();
          bSnap.forEach((d) => {
            const b = d.data() as StudentBoard;
            boardMap.set(b.studentId, b);
          });

          const boardsList: SavedBoardSnapshot[] = liveParticipants.map((p) => {
            const found = boardMap.get(p.uid);
            return {
              studentId: p.uid,
              studentName: p.fullNameQuad,
              strokes: found?.strokes ?? [],
              submitted: found?.submitted ?? false,
              verdict: found?.verdict ?? 'pending',
            };
          });

          // Include any extra board not in participants list just in case
          boardMap.forEach((b, sid) => {
            if (!liveParticipants.some((p) => p.uid === sid)) {
              boardsList.push({
                studentId: b.studentId,
                studentName: b.studentName,
                strokes: b.strokes ?? [],
                submitted: b.submitted ?? false,
                verdict: b.verdict ?? 'pending',
              });
            }
          });

          assembledQuestions.push({
            id: q.id,
            ownerId: profile.uid,
            orderIndex: q.orderIndex,
            text: q.text,
            imageData: q.imageData,
            status: q.status,
            winnerName: q.winnerName,
            boards: boardsList,
            createdAt: q.createdAt,
          });
        }

        const pSummary: ParticipantSummary[] = [...liveParticipants]
          .sort((a, b) => b.score - a.score || b.correctCount - a.correctCount)
          .map((p) => ({
            uid: p.uid,
            fullNameQuad: p.fullNameQuad,
            score: p.score,
            correctCount: p.correctCount,
          }));

        if (cancelled) return;
        setQuestionsData(assembledQuestions);
        setParticipantsData(pSummary);

        // Auto-save full test + all boards into the user's own personal savedTests archive
        const savedTestRef = doc(db, 'users', profile.uid, 'savedTests', liveRoom.id);
        const existingSaved = await getDoc(savedTestRef);
        if (!existingSaved.exists()) {
          const batch = writeBatch(db);
          batch.set(savedTestRef, {
            id: liveRoom.id,
            ownerId: profile.uid,
            roomCode: liveRoom.id,
            title: liveRoom.title,
            userRole: isSupervisor ? 'supervisor' : 'student',
            supervisorName: liveRoom.supervisorName,
            totalQuestions: assembledQuestions.length,
            participantsSummary: pSummary,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });

          for (const sq of assembledQuestions) {
            const sqRef = doc(
              db,
              'users',
              profile.uid,
              'savedTests',
              liveRoom.id,
              'questions',
              sq.id
            );
            batch.set(sqRef, {
              id: sq.id,
              ownerId: profile.uid,
              orderIndex: sq.orderIndex,
              text: sq.text,
              imageData: sq.imageData,
              status: sq.status,
              winnerName: sq.winnerName,
              boards: sq.boards,
              createdAt: serverTimestamp(),
            });
          }

          await batch.commit();
        }
        if (!cancelled) {
          setSavedNotice(true);
        }
      } catch (err) {
        handleFirestoreError(err, OperationType.WRITE, `users/${profile.uid}/savedTests`);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void loadAndPersistLiveResults();
    return () => {
      cancelled = true;
    };
  }, [liveRoom?.id, profile.uid, isSupervisor]);

  const sortedParticipants = [...participantsData].sort(
    (a, b) => b.score - a.score || b.correctCount - a.correctCount
  );

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 py-8 flex flex-col gap-6">
      {/* Top Celebration Banner */}
      <div className="duo-card p-6 sm:p-8 flex flex-col md:flex-row items-center justify-between gap-6">
        <div className="flex flex-col sm:flex-row items-center gap-5 text-center sm:text-right">
          <DuoArtwork
            src={DUO_IMAGES.trophy}
            alt="كأس نهاية الاختبار"
            className="w-28 h-28 shrink-0"
          />
          <div className="flex flex-col gap-1">
            <span className="text-xs font-extrabold text-[#E5A400]">
              النتائج النهائية وسجل الصبورات
            </span>
            <h1 className="text-2xl sm:text-3xl font-black text-[#3C3C3C]">{title}</h1>
            <p className="text-sm font-bold text-[#777777]">
              المشرف: <span className="text-[#3C3C3C]">{supervisorName}</span>
              {' · '}
              رمز الغرفة:{' '}
              <span className="font-latin font-black text-[#1CB0F6]">{roomCode}</span>
              {' · '}
              عدد الأسئلة:{' '}
              <span className="font-latin font-black text-[#3C3C3C]">
                {questionsData.length}
              </span>
            </p>
            {savedNotice && (
              <div className="flex items-center justify-center sm:justify-start gap-1.5 text-xs font-extrabold text-[#46A302] mt-1">
                <CheckCircle2 className="w-4 h-4" />
                <span>تم حفظ الاختبار كاملاً مع جميع الصبورات في حسابك</span>
              </div>
            )}
          </div>
        </div>

        <button
          type="button"
          onClick={onBack}
          className="duo-btn flex items-center gap-2 px-6 py-3.5 rounded-2xl bg-[#1CB0F6] hover:bg-[#33BCFF] border-2 border-[#1899D6] border-b-[5px] text-white text-base font-black cursor-pointer whitespace-nowrap"
        >
          <ArrowRight className="w-5 h-5" />
          <span>العودة للرئيسية</span>
        </button>
      </div>

      {loading ? (
        <div className="duo-card p-12 text-center text-base font-extrabold text-[#777777]">
          جاري تجميع الأسئلة وصبورات الطلاب وحفظها في حسابك...
        </div>
      ) : (
        <>
          {/* Leaderboard */}
          <div className="duo-card p-6 flex flex-col gap-4">
            <div className="flex items-center gap-2.5 pb-3 border-b-2 border-[#F0F0F0]">
              <DuoCrownIcon className="w-6 h-6" />
              <h2 className="text-xl font-black text-[#3C3C3C]">ترتيب الطلاب</h2>
            </div>

            {sortedParticipants.length === 0 ? (
              <p className="text-sm font-bold text-[#777777]">لم يشارك طلاب في هذه الجلسة.</p>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {sortedParticipants.map((p, idx) => (
                  <div
                    key={p.uid}
                    className={`flex items-center justify-between gap-3 p-4 rounded-2xl border-2 ${
                      idx === 0 && p.score > 0
                        ? 'bg-[#FFF4CC]/60 border-[#FFC800]'
                        : 'bg-[#F7F7F7] border-[#E5E5E5]'
                    }`}
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <span
                        className={`font-latin w-9 h-9 rounded-xl flex items-center justify-center font-black text-base shrink-0 ${
                          idx === 0 && p.score > 0
                            ? 'bg-[#FFC800] text-[#3C3C3C]'
                            : 'bg-white border-2 border-[#E5E5E5] text-[#777777]'
                        }`}
                      >
                        {idx + 1}
                      </span>
                      <div className="min-w-0">
                        <p className="text-sm font-black text-[#3C3C3C] truncate">
                          {p.fullNameQuad}
                        </p>
                        <p className="text-xs font-bold text-[#777777]">
                          الإجابات الصحيحة:{' '}
                          <span className="font-latin font-black text-[#46A302]">
                            {p.correctCount}
                          </span>
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <DuoGemIcon className="w-4 h-4" />
                      <span className="font-latin text-base font-black text-[#1899D6]">
                        {p.score}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* All Questions & Student Whiteboards */}
          <div className="flex flex-col gap-5">
            <h2 className="text-xl font-black text-[#3C3C3C]">
              الأسئلة وصبورات جميع الطلاب ({questionsData.length})
            </h2>

            {questionsData.length === 0 ? (
              <div className="duo-card p-8 text-center text-sm font-bold text-[#777777]">
                لم يتم إدراج أسئلة في هذا الاختبار.
              </div>
            ) : (
              questionsData.map((q) => (
                <div key={q.id} className="duo-card p-5 sm:p-6 flex flex-col gap-5">
                  {/* Question Header */}
                  <div className="flex flex-wrap items-center justify-between gap-3 pb-4 border-b-2 border-[#F0F0F0]">
                    <div className="flex items-center gap-2.5">
                      <span className="font-latin px-3 py-1 rounded-xl bg-[#1CB0F6] text-white text-sm font-black">
                        س{q.orderIndex}
                      </span>
                      <h3 className="text-lg font-black text-[#3C3C3C]">
                        {q.text || 'سؤال بصورة مرفقة'}
                      </h3>
                    </div>

                    {q.status === 'correct' && q.winnerName ? (
                      <div className="flex items-center gap-2 text-[#46A302] font-black text-sm">
                        <DuoCheckBadge className="w-5 h-5" />
                        <span>أجابه: {q.winnerName}</span>
                      </div>
                    ) : (
                      <div className="flex items-center gap-2 text-[#EA2B2B] font-black text-sm">
                        <DuoCrossBadge className="w-5 h-5" />
                        <span>لم تُحسب الإجابة لأحد</span>
                      </div>
                    )}
                  </div>

                  {q.imageData && (
                    <div>
                      <button
                        type="button"
                        onClick={() => setZoomedImg(q.imageData)}
                        className="relative rounded-2xl overflow-hidden border-2 border-[#E5E5E5] bg-[#F7F7F7] cursor-pointer"
                      >
                        <img
                          src={q.imageData}
                          alt={`صورة السؤال ${q.orderIndex}`}
                          className="max-h-44 w-auto object-contain"
                        />
                      </button>
                    </div>
                  )}

                  {/* Student Boards for This Question */}
                  {q.boards.length === 0 ? (
                    <p className="text-sm font-bold text-[#777777]">
                      لا توجد صبورات مسجلة لهذا السؤال.
                    </p>
                  ) : (
                    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                      {q.boards.map((b) => (
                        <div
                          key={b.studentId}
                          className={`p-3.5 rounded-2xl border-2 flex flex-col gap-2.5 ${
                            b.verdict === 'correct'
                              ? 'border-[#58CC02] bg-[#D7FFB8]/30'
                              : b.verdict === 'wrong'
                              ? 'border-[#FF4B4B] bg-[#FFDFE0]/30'
                              : 'border-[#E5E5E5] bg-[#F7F7F7]'
                          }`}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <div className="min-w-0">
                              <p className="text-sm font-black text-[#3C3C3C] truncate">
                                {b.studentName}
                              </p>
                              <p className="text-xs font-bold text-[#777777]">
                                {b.verdict === 'correct'
                                  ? 'إجابة صحيحة'
                                  : b.verdict === 'wrong'
                                  ? 'إجابة خاطئة'
                                  : b.submitted
                                  ? 'تم التسليم'
                                  : 'لم يُسلّم'}
                              </p>
                            </div>
                            <button
                              type="button"
                              onClick={() => setZoomedBoard(b)}
                              className="p-2 rounded-xl bg-white border border-[#E5E5E5] text-[#3C3C3C] hover:text-[#1899D6] cursor-pointer"
                              title="تكبير السبورة"
                            >
                              <ZoomIn className="w-4 h-4" />
                            </button>
                          </div>
                          <WhiteboardPreview
                            strokes={b.strokes || []}
                            emptyText="سبورة فارغة"
                          />
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))
            )}
          </div>
        </>
      )}

      {/* Zoomed Board Modal */}
      {zoomedBoard && (
        <div
          className="fixed inset-0 z-50 bg-black/75 flex items-center justify-center p-4"
          onClick={() => setZoomedBoard(null)}
        >
          <div
            className="bg-white rounded-3xl p-5 max-w-4xl w-full flex flex-col gap-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex justify-between items-center">
              <h3 className="text-lg font-black text-[#3C3C3C]">
                سبورة: {zoomedBoard.studentName}
              </h3>
              <button
                type="button"
                onClick={() => setZoomedBoard(null)}
                className="p-2 rounded-xl bg-[#F7F7F7] hover:bg-[#FFDFE0] text-[#3C3C3C] cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <WhiteboardPreview
              strokes={zoomedBoard.strokes || []}
              className="w-full aspect-[12/7]"
            />
          </div>
        </div>
      )}

      {/* Zoomed Question Image Modal */}
      {zoomedImg && (
        <div
          className="fixed inset-0 z-50 bg-black/75 flex items-center justify-center p-4"
          onClick={() => setZoomedImg(null)}
        >
          <div
            className="bg-white rounded-3xl p-4 max-w-4xl w-full flex flex-col gap-3"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex justify-between items-center">
              <span className="font-black text-[#3C3C3C]">صورة السؤال</span>
              <button
                type="button"
                onClick={() => setZoomedImg(null)}
                className="p-2 rounded-xl bg-[#F7F7F7] hover:bg-[#FFDFE0] text-[#3C3C3C] cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <img
              src={zoomedImg}
              alt="صورة السؤال"
              className="max-h-[75vh] w-auto mx-auto object-contain rounded-xl"
            />
          </div>
        </div>
      )}
    </div>
  );
};
