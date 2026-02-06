export type InitResponse = {
  type: "init";
  postId: string;
  username: string;
};

// Add your game-specific API types here
// Examples:
// export type SaveScoreRequest = {
//   score: number;
//   level: number;
// };
// 
// export type LeaderboardResponse = {
//   entries: Array<{ username: string; score: number; rank: number }>;
// };

// Simplified Request: No round ID needed
export type SubmitScoreRequest = {
  type: "submit-score";
  score: number;
};

// Simplified Response: Returns the rank immediately
export type SubmitScoreResponse = {
  success: boolean;
  score: number;       // The user's best score (might be higher than the one just submitted)
  rank: number;        // Current rank on the simplified leaderboard
  totalPlayers: number; 
  isNewBest: boolean;  // Did they beat their previous score?
};

export type StoredState = {
  username: string;
  bestScore?: number;
  data?: Record<string, unknown>;
  updatedAt: number;
};