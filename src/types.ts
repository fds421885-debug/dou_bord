export interface Stroke {
  color: string;
  width: number;
  isEraser: boolean;
  pts: number[];
}

export interface UserProfile {
  uid: string;
  fullNameQuad: string;
  email: string;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export type RoomStatus = 'waiting' | 'active' | 'finished';

export interface Room {
  id: string;
  title: string;
  supervisorId: string;
  supervisorName: string;
  status: RoomStatus;
  currentQuestionId: string;
  questionCount: number;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface Participant {
  uid: string;
  roomId: string;
  fullNameQuad: string;
  score: number;
  correctCount: number;
  joinedAt?: unknown;
  updatedAt?: unknown;
}

export type QuestionStatus = 'solving' | 'correct' | 'unanswered';

export interface Question {
  id: string;
  roomId: string;
  orderIndex: number;
  text: string;
  imageData: string;
  status: QuestionStatus;
  attemptsUsed: number;
  wrongStudentIds: string[];
  winnerId: string;
  winnerName: string;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export type BoardVerdict = 'pending' | 'correct' | 'wrong';

export interface StudentBoard {
  studentId: string;
  studentName: string;
  roomId: string;
  questionId: string;
  strokes: Stroke[];
  submitted: boolean;
  verdict: BoardVerdict;
  updatedAt?: unknown;
}

export interface ParticipantSummary {
  uid: string;
  fullNameQuad: string;
  score: number;
  correctCount: number;
}

export interface SavedBoardSnapshot {
  studentId: string;
  studentName: string;
  strokes: Stroke[];
  submitted: boolean;
  verdict: BoardVerdict;
}

export interface SavedQuestion {
  id: string;
  ownerId: string;
  orderIndex: number;
  text: string;
  imageData: string;
  status: QuestionStatus;
  winnerName: string;
  boards: SavedBoardSnapshot[];
  createdAt?: unknown;
}

export interface SavedTest {
  id: string;
  ownerId: string;
  roomCode: string;
  title: string;
  userRole: 'supervisor' | 'student';
  supervisorName: string;
  totalQuestions: number;
  participantsSummary: ParticipantSummary[];
  createdAt?: unknown;
  updatedAt?: unknown;
}
