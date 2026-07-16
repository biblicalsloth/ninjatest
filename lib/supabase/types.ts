export type CatSection = "VARC" | "DILR" | "QUANT";
export type MatchStatus = "pending" | "active" | "completed" | "abandoned";
export type QueueStatus = "waiting" | "matched" | "cancelled";

export interface Database {
  public: {
    Tables: {
      profiles: {
        Row: {
          id: string;
          username: string;
          display_name: string | null;
          avatar_url: string | null;
          elo: number;
          peak_elo: number;
          matches_played: number;
          wins: number;
          losses: number;
          draws: number;
          current_streak: number;
          best_streak: number;
          exam: string | null;
          exam_year: number | null;
          onboarding_completed: boolean;
          created_at: string;
        };
        Insert: Omit<Database["public"]["Tables"]["profiles"]["Row"], "created_at">;
        Update: Partial<Database["public"]["Tables"]["profiles"]["Insert"]>;
      };
      questions: {
        Row: {
          id: string;
          section: CatSection;
          difficulty: number;
          body: string;
          options: string[];
          correct_index: number;
          explanation: string | null;
          duration_ms: number | null;
          is_active: boolean;
          created_at: string;
        };
        Insert: Omit<Database["public"]["Tables"]["questions"]["Row"], "id" | "created_at">;
        Update: Partial<Database["public"]["Tables"]["questions"]["Insert"]>;
      };
      section_config: {
        Row: {
          section: CatSection;
          cap_ms: number;
          base_points: number;
          speed_mult: number;
          grace_block_ms: number;
          wrong_penalty: number;
        };
        Insert: Database["public"]["Tables"]["section_config"]["Row"];
        Update: Partial<Database["public"]["Tables"]["section_config"]["Row"]>;
      };
      matches: {
        Row: {
          id: string;
          player_a: string;
          player_b: string;
          status: MatchStatus;
          is_rated: boolean;
          question_ids: string[];
          current_index: number;
          question_started_at: string | null;
          score_a: number;
          score_b: number;
          correct_a: number;
          correct_b: number;
          time_a_ms: number;
          time_b_ms: number;
          winner_id: string | null;
          elo_a_before: number | null;
          elo_b_before: number | null;
          elo_a_after: number | null;
          elo_b_after: number | null;
          created_at: string;
          started_at: string | null;
          ended_at: string | null;
        };
        Insert: Omit<Database["public"]["Tables"]["matches"]["Row"], "id" | "created_at">;
        Update: Partial<Database["public"]["Tables"]["matches"]["Insert"]>;
      };
      match_answers: {
        Row: {
          id: string;
          match_id: string;
          user_id: string;
          question_id: string;
          question_index: number;
          selected_index: number | null;
          answer_text: string | null;   // TITA: the typed answer. null for mcq.
          is_correct: boolean;
          points_awarded: number;
          time_taken_ms: number | null;
          answered_at: string;
        };
        Insert: Omit<Database["public"]["Tables"]["match_answers"]["Row"], "id" | "answered_at">;
        Update: Partial<Database["public"]["Tables"]["match_answers"]["Insert"]>;
      };
      rating_history: {
        Row: {
          id: number;
          user_id: string;
          match_id: string | null;
          elo_before: number;
          elo_after: number;
          delta: number;
          created_at: string;
        };
        Insert: Omit<Database["public"]["Tables"]["rating_history"]["Row"], "id" | "created_at">;
        Update: Partial<Database["public"]["Tables"]["rating_history"]["Insert"]>;
      };
      matchmaking_queue: {
        Row: {
          id: string;
          user_id: string;
          elo: number;
          status: QueueStatus;
          match_id: string | null;
          enqueued_at: string;
        };
        Insert: Omit<Database["public"]["Tables"]["matchmaking_queue"]["Row"], "id" | "enqueued_at">;
        Update: Partial<Database["public"]["Tables"]["matchmaking_queue"]["Insert"]>;
      };
      challenges: {
        Row: {
          id: string;
          code: string;
          host_id: string;
          guest_id: string | null;
          is_rated: boolean;
          section_mode: CatSection | null;
          match_id: string | null;
          expires_at: string;
          created_at: string;
        };
        Insert: Omit<Database["public"]["Tables"]["challenges"]["Row"], "id" | "created_at">;
        Update: Partial<Database["public"]["Tables"]["challenges"]["Insert"]>;
      };
      seasons: {
        Row: { id: number; name: string; starts_at: string; ends_at: string; created_at: string };
        Insert: Omit<Database["public"]["Tables"]["seasons"]["Row"], "id" | "created_at">;
        Update: Partial<Database["public"]["Tables"]["seasons"]["Insert"]>;
      };
      season_results: {
        Row: { season_id: number; user_id: string; final_elo: number; final_rank: number };
        Insert: Database["public"]["Tables"]["season_results"]["Row"];
        Update: Partial<Database["public"]["Tables"]["season_results"]["Row"]>;
      };
      friendships: {
        Row: {
          user_a: string;
          user_b: string;
          status: "pending" | "accepted";
          requested_by: string;
          created_at: string;
        };
        Insert: Omit<Database["public"]["Tables"]["friendships"]["Row"], "created_at">;
        Update: Partial<Database["public"]["Tables"]["friendships"]["Insert"]>;
      };
      waitlist: {
        Row: {
          id: string;
          email: string;
          created_at: string;
          name: string | null;
          phone: string | null;
          year: string | null;
          percentile: string | null;
          section: string | null;
        };
        Insert: {
          email: string;
          name?: string | null;
          phone?: string | null;
          year?: string | null;
          percentile?: string | null;
          section?: string | null;
        };
        Update: Partial<{
          email: string;
          name: string | null;
          phone: string | null;
          year: string | null;
          percentile: string | null;
          section: string | null;
        }>;
      };
    };
    Functions: {
      join_queue: { Args: Record<string, never>; Returns: void };
      leave_queue: { Args: Record<string, never>; Returns: void };
      try_match: { Args: Record<string, never>; Returns: string | null };
      create_challenge: { Args: { p_is_rated: boolean; p_section_mode: CatSection | null }; Returns: string };
      accept_challenge: { Args: { p_code: string }; Returns: string };
      get_match_question: {
        Args: { p_match_id: string; p_index: number };
        Returns: {
          question_id: string;
          section: CatSection;
          body: string;
          options: string[];
          cap_ms: number;
          started_at: string;
        }[];
      };
      submit_answer: {
        Args: {
          p_match_id: string;
          p_question_index: number;
          p_selected_index: number | null;
        };
        Returns: void;
      };
      finalize_match: { Args: { p_match_id: string }; Returns: void };
      get_leaderboard: {
        Args: { p_limit: number; p_offset: number };
        Returns: {
          rank: number;
          username: string;
          display_name: string | null;
          elo: number;
          wins: number;
          losses: number;
          draws: number;
          avatar_url: string | null;
        }[];
      };
      get_profile: { Args: { p_username: string }; Returns: unknown };
      get_profile_matches: {
        Args: { p_username: string; p_limit: number };
        Returns: {
          match_id: string;
          opponent: string;
          opponent_avatar: string | null;
          my_score: number;
          opp_score: number;
          result: string;
          elo_delta: number;
          played_at: string;
        }[];
      };
      get_section_stats: {
        Args: { p_username: string };
        Returns: {
          section: CatSection;
          questions_answered: number;
          correct: number;
          accuracy: number;
          avg_points: number;
        }[];
      };
      start_match: { Args: { p_match_id: string }; Returns: void };
      get_recent_matches: {
        Args: { p_limit: number };
        Returns: {
          match_id: string;
          opponent: string;
          opponent_avatar: string | null;
          my_score: number;
          opp_score: number;
          result: string;
          elo_delta: number;
          played_at: string;
        }[];
      };
      forfeit_match: { Args: { p_match_id: string }; Returns: void };
      get_answer_reveal: {
        Args: { p_match_id: string; p_index: number };
        Returns: {
          correct_index: number;
          explanation: string | null;
          points_awarded: number;
          is_correct: boolean;
        }[];
      };
      apply_draw: { Args: { p_match_id: string }; Returns: void };
      apply_rated_result: { Args: { p_match_id: string; p_winner: string; p_loser: string; p_delta: number }; Returns: void };
      maybe_advance: { Args: { p_match_id: string; p_index: number }; Returns: void };
      advance_timed_out: { Args: Record<string, never>; Returns: void };
      get_current_season: {
        Args: Record<string, never>;
        Returns: { name: string; ends_at: string }[];
      };
      search_profiles: {
        Args: { p_query: string; p_limit: number };
        Returns: { id: string; username: string; display_name: string | null; avatar_url: string | null; elo: number }[];
      };
      send_friend_request: { Args: { p_target_id: string }; Returns: void };
      respond_friend_request: { Args: { p_other_id: string; p_accept: boolean }; Returns: void };
      remove_friend: { Args: { p_other_id: string }; Returns: void };
      get_spectator_match: {
        Args: { p_match_id: string };
        Returns: {
          match_id: string;
          status: MatchStatus;
          current_index: number;
          score_a: number;
          score_b: number;
          player_a_username: string;
          player_a_avatar: string | null;
          player_b_username: string;
          player_b_avatar: string | null;
        }[];
      };
      get_match_question_spectator: {
        Args: { p_match_id: string; p_index: number };
        Returns: {
          question_id: string;
          section: CatSection;
          body: string;
          options: string[];
          cap_ms: number;
          started_at: string;
        }[];
      };
      get_active_matches: {
        Args: { p_limit: number };
        Returns: {
          match_id: string;
          player_a_username: string;
          player_a_elo: number;
          player_b_username: string;
          player_b_elo: number;
          score_a: number;
          score_b: number;
          current_index: number;
          started_at: string;
        }[];
      };
      get_daily_progress: {
        Args: Record<string, never>;
        Returns: { matches_today: number; wins_today: number };
      };
      get_friends: {
        Args: Record<string, never>;
        Returns: {
          other_id: string;
          username: string;
          display_name: string | null;
          avatar_url: string | null;
          elo: number;
          relation: "accepted" | "incoming" | "outgoing";
        }[];
      };
    };
    Enums: {
      cat_section: CatSection;
      match_status: MatchStatus;
      queue_status: QueueStatus;
    };
  };
}

export type Profile = Database["public"]["Tables"]["profiles"]["Row"];
export type Match = Database["public"]["Tables"]["matches"]["Row"];
export type MatchAnswer = Database["public"]["Tables"]["match_answers"]["Row"];
export type RatingHistory = Database["public"]["Tables"]["rating_history"]["Row"];
export type Challenge = Database["public"]["Tables"]["challenges"]["Row"];
export type Question = Database["public"]["Tables"]["questions"]["Row"];
export type SectionConfig = Database["public"]["Tables"]["section_config"]["Row"];

export type QuestionType = "mcq" | "tita";

export interface MatchQuestion {
  question_id: string;
  section: CatSection;
  body: string;
  /** empty for tita — the answer is typed, not picked */
  options: string[];
  qtype: QuestionType;
  cap_ms: number;
  started_at: string;
  passage: string | null;
  image_url: string | null;
  passage_image_url: string | null;
}
