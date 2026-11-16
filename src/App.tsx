import React, { Component, useEffect, useState } from 'react';
import { onAuthStateChanged, signOut, type User } from 'firebase/auth';
import {
  collection,
  doc,
  getDoc,
  onSnapshot,
  query,
  where,
} from 'firebase/firestore';
import { Archive, Home, LogOut } from 'lucide-react';
import {
  auth,
  db,
  getTimestampMillis,
  handleFirestoreError,
  OperationType,
} from './firebase';
import type { Participant, Room, UserProfile } from './types';
import { AuthGate } from './components/AuthGate';
import { RoleHub } from './components/RoleHub';
import { WaitingRoom } from './components/WaitingRoom';
import { QuizArena } from './components/QuizArena';
import { InteractiveArena } from './components/InteractiveArena';
import { TestResultsView } from './components/TestResultsView';
import { SavedTestsView } from './components/SavedTestsView';
import { DuoOwlEmblem } from './components/DuoIcons';

interface ErrorBoundaryState {
  hasError: boolean;
}

class AppErrorBoundary extends Component<
  { children: React.ReactNode },
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true };
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen flex items-center justify-center p-6 bg-white">
          <div className="duo-card max-w-md w-full p-8 text-center flex flex-col items-center gap-4">
            <DuoOwlEmblem className="w-16 h-16" />
            <h1 className="text-xl font-black text-[#3C3C3C]">
              حدث خطأ غير متوقع
            </h1>
            <p className="text-sm font-bold text-[#777777]">
              يرجى تحديث الصفحة لإعادة الاتصال بقاعدة البيانات.
            </p>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="duo-btn px-6 py-3 rounded-2xl bg-[#58CC02] border-2 border-b-4 border-[#46A302] text-white font-black cursor-pointer"
            >
              تحديث الصفحة
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

const ROOM_STORAGE_PREFIX = 'duoboard_active_room_';

function persistActiveRoom(uid: string, roomId: string | null) {
  try {
    const key = `${ROOM_STORAGE_PREFIX}${uid}`;
    if (roomId) {
      localStorage.setItem(key, roomId);
      const url = new URL(window.location.href);
      url.searchParams.set('room', roomId);
      window.history.replaceState({}, '', url.toString());
    } else {
      localStorage.removeItem(key);
      const url = new URL(window.location.href);
      if (url.searchParams.has('room')) {
        url.searchParams.delete('room');
        window.history.replaceState({}, '', url.toString());
      }
    }
  } catch {
    // Ignore storage/history errors in restricted contexts
  }
}

function getCandidateSavedRoom(uid: string): string | null {
  try {
    const fromStorage = localStorage.getItem(`${ROOM_STORAGE_PREFIX}${uid}`);
    const fromUrl = new URLSearchParams(window.location.search).get('room');
    const raw = (fromStorage || fromUrl || '').trim().toUpperCase();
    if (/^[A-Z0-9_-]{4,16}$/.test(raw)) return raw;
    return null;
  } catch {
    return null;
  }
}

export default function App() {
  const [authReady, setAuthReady] = useState(false);
  const [firebaseUser, setFirebaseUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [profileLoading, setProfileLoading] = useState(false);

  const [tab, setTab] = useState<'home' | 'saved'>('home');
  const [activeRoomId, setActiveRoomId] = useState<string | null>(null);
  const [room, setRoom] = useState<Room | null>(null);
  const [participants, setParticipants] = useState<Participant[]>([]);

  const handleEnterRoom = (roomId: string) => {
    setActiveRoomId(roomId);
    if (firebaseUser) {
      persistActiveRoom(firebaseUser.uid, roomId);
    }
  };

  const handleLeaveRoom = (nextTab: 'home' | 'saved' = 'home') => {
    setActiveRoomId(null);
    setTab(nextTab);
    if (firebaseUser) {
      persistActiveRoom(firebaseUser.uid, null);
    }
  };

  // Auth listener & room session restore on refresh
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (user) => {
      setFirebaseUser(user);
      if (!user) {
        setProfile(null);
        setActiveRoomId(null);
        setRoom(null);
        setParticipants([]);
        setAuthReady(true);
        return;
      }

      setProfileLoading(true);
      const path = `users/${user.uid}/private/profile`;
      try {
        const snap = await getDoc(doc(db, 'users', user.uid, 'private', 'profile'));
        if (snap.exists()) {
          setProfile(snap.data() as UserProfile);

          // Restore active room if user refreshed the page while inside a room
          const candidateRoom = getCandidateSavedRoom(user.uid);
          if (candidateRoom) {
            try {
              const rSnap = await getDoc(doc(db, 'rooms', candidateRoom));
              if (rSnap.exists()) {
                const rData = rSnap.data() as Room;
                if (rData.supervisorId === user.uid) {
                  setActiveRoomId(candidateRoom);
                  persistActiveRoom(user.uid, candidateRoom);
                } else {
                  const pSnap = await getDoc(
                    doc(db, 'rooms', candidateRoom, 'participants', user.uid)
                  );
                  if (pSnap.exists()) {
                    setActiveRoomId(candidateRoom);
                    persistActiveRoom(user.uid, candidateRoom);
                  } else {
                    persistActiveRoom(user.uid, null);
                  }
                }
              } else {
                persistActiveRoom(user.uid, null);
              }
            } catch {
              persistActiveRoom(user.uid, null);
            }
          }
        } else {
          setProfile(null);
        }
      } catch (err) {
        handleFirestoreError(err, OperationType.GET, path);
      } finally {
        setProfileLoading(false);
        setAuthReady(true);
      }
    });
    return () => unsub();
  }, []);

  // Room & Participants real-time listeners
  useEffect(() => {
    if (!activeRoomId || !firebaseUser) {
      setRoom(null);
      setParticipants([]);
      return;
    }

    const rPath = `rooms/${activeRoomId}`;
    const unsubRoom = onSnapshot(
      doc(db, 'rooms', activeRoomId),
      (snap) => {
        if (snap.exists()) {
          setRoom(snap.data() as Room);
        } else {
          setRoom(null);
          setActiveRoomId(null);
          persistActiveRoom(firebaseUser.uid, null);
        }
      },
      (err) => {
        handleFirestoreError(err, OperationType.GET, rPath);
      }
    );

    const pPath = `rooms/${activeRoomId}/participants`;
    const pQuery = query(
      collection(db, 'rooms', activeRoomId, 'participants'),
      where('roomId', '==', activeRoomId)
    );
    const unsubParts = onSnapshot(
      pQuery,
      (snap) => {
        const list: Participant[] = [];
        snap.forEach((d) => list.push(d.data() as Participant));
        list.sort((a, b) => getTimestampMillis(a.joinedAt) - getTimestampMillis(b.joinedAt));
        setParticipants(list);
      },
      (err) => {
        handleFirestoreError(err, OperationType.LIST, pPath);
      }
    );

    return () => {
      unsubRoom();
      unsubParts();
    };
  }, [activeRoomId, firebaseUser]);

  if (!authReady || profileLoading) {
    return (
      <div className="min-h-screen bg-white flex flex-col items-center justify-center gap-4">
        <DuoOwlEmblem className="w-16 h-16 animate-bounce" />
        <p className="text-base font-black text-[#777777]">جاري تجهيز السبورة التفاعلية...</p>
      </div>
    );
  }

  if (!firebaseUser || !profile) {
    return (
      <AppErrorBoundary>
        <AuthGate
          firebaseUser={firebaseUser}
          profile={profile}
          onProfileSaved={(saved) => setProfile(saved)}
        />
      </AppErrorBoundary>
    );
  }

  const isSupervisor = Boolean(room && room.supervisorId === profile.uid);

  return (
    <AppErrorBoundary>
      <div className="min-h-screen bg-[#FFFFFF] flex flex-col overflow-x-hidden">
        {/* Clean 3-Zone Duolingo Top Navigation Bar */}
        <header className="border-b-2 border-[#E5E5E5] bg-white sticky top-0 z-30">
          <div className="max-w-7xl mx-auto px-3 sm:px-6 h-14 sm:h-16 flex items-center justify-between gap-2 sm:gap-6 md:gap-8">
            {/* Zone 1: Brand Wordmark */}
            <button
              type="button"
              onClick={() => {
                if (!activeRoomId) setTab('home');
              }}
              className="flex items-center gap-1.5 sm:gap-2.5 whitespace-nowrap shrink-0 cursor-pointer"
            >
              <DuoOwlEmblem className="w-7 h-7 sm:w-8 sm:h-8" />
              <span className="font-latin text-lg sm:text-2xl font-black tracking-tight text-[#58CC02]">
                DuoBoard
              </span>
            </button>

            {/* Zone 2: Navigation Links */}
            {!activeRoomId ? (
              <nav className="flex items-center gap-3 sm:gap-6 text-xs sm:text-sm font-black">
                <button
                  type="button"
                  onClick={() => setTab('home')}
                  className={`flex items-center gap-1 sm:gap-1.5 py-2 border-b-2 transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                    tab === 'home'
                      ? 'border-[#58CC02] text-[#58CC02]'
                      : 'border-transparent text-[#777777] hover:text-[#3C3C3C]'
                  }`}
                >
                  <Home className="w-4 h-4" />
                  <span>الرئيسية</span>
                </button>
                <button
                  type="button"
                  onClick={() => setTab('saved')}
                  className={`flex items-center gap-1 sm:gap-1.5 py-2 border-b-2 transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                    tab === 'saved'
                      ? 'border-[#1CB0F6] text-[#1899D6]'
                      : 'border-transparent text-[#777777] hover:text-[#3C3C3C]'
                  }`}
                >
                  <Archive className="w-4 h-4" />
                  <span className="sm:hidden">اختباراتي</span>
                  <span className="hidden sm:inline">اختباراتي المحفوظة</span>
                </button>
              </nav>
            ) : (
              <div className="flex items-center gap-2 text-xs sm:text-sm font-black text-[#3C3C3C] truncate max-w-[140px] sm:max-w-md">
                <span className="truncate">{room?.title ?? 'غرفة الاختبار'}</span>
              </div>
            )}

            {/* Zone 3: Primary Action */}
            <div className="flex items-center shrink-0">
              {activeRoomId ? (
                <button
                  type="button"
                  onClick={() => handleLeaveRoom('home')}
                  className="duo-btn px-2.5 sm:px-4 py-1.5 sm:py-2 rounded-xl bg-white border-2 border-b-4 border-[#E5E5E5] text-[11px] sm:text-xs font-black text-[#777777] hover:text-[#3C3C3C] whitespace-nowrap shrink-0 cursor-pointer"
                >
                  <span className="sm:hidden">مغادرة</span>
                  <span className="hidden sm:inline">مغادرة الغرفة</span>
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => void signOut(auth)}
                  className="duo-btn flex items-center gap-1.5 px-2.5 sm:px-4 py-1.5 sm:py-2 rounded-xl bg-white border-2 border-b-4 border-[#E5E5E5] text-[11px] sm:text-xs font-black text-[#777777] hover:text-[#EA2B2B] whitespace-nowrap shrink-0 cursor-pointer"
                >
                  <LogOut className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
                  <span className="sm:hidden">خروج</span>
                  <span className="hidden sm:inline">تسجيل الخروج</span>
                </button>
              )}
            </div>
          </div>
        </header>

        {/* Main Content */}
        <main className="flex-1">
          {activeRoomId ? (
            !room ? (
              <div className="max-w-3xl mx-auto px-4 py-16 text-center">
                <p className="text-base font-black text-[#777777]">جاري الاتصال بالغرفة...</p>
              </div>
            ) : room.status === 'waiting' ? (
              <WaitingRoom
                room={room}
                participants={participants}
                isSupervisor={isSupervisor}
                onLeaveRoom={() => handleLeaveRoom('home')}
              />
            ) : room.status === 'active' ? (
              room.sessionType === 'interactive' ? (
                <InteractiveArena
                  room={room}
                  profile={profile}
                  participants={participants}
                  isSupervisor={isSupervisor}
                />
              ) : (
                <QuizArena
                  room={room}
                  profile={profile}
                  participants={participants}
                  isSupervisor={isSupervisor}
                />
              )
            ) : (
              <TestResultsView
                profile={profile}
                liveRoom={room}
                liveParticipants={participants}
                isSupervisor={isSupervisor}
                onBack={() => handleLeaveRoom('saved')}
              />
            )
          ) : tab === 'home' ? (
            <RoleHub
              profile={profile}
              onProfileUpdated={(next) => setProfile(next)}
              onEnterRoom={(roomId) => handleEnterRoom(roomId)}
            />
          ) : (
            <SavedTestsView profile={profile} />
          )}
        </main>
      </div>
    </AppErrorBoundary>
  );
}
