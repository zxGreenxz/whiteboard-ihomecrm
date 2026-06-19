// =============================================
// useTeams — Đội ngũ (Teams): nhóm nhân viên cùng đội thấy nhau + bàn giao nội đội.
//
// Bảng `teams` / `team_members` (xem migration 20260619120000_teams.sql).
// RLS: chủ (user_id = auth.uid()) toàn quyền; thành viên xem đội mình.
// `user_id` (chủ) do trigger set_user_id_from_auth tự gán = auth.uid() khi insert.
// Visibility profiles của đồng đội mở qua policy profiles_select_same_team.
//
// Dùng `as any` cho tên bảng vì types.ts chưa regen (theo pattern repo cho
// bảng mới — vd income_expense_types). Regen types từ live DB khi rảnh.
// =============================================

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export interface TeamMemberLite {
  member_id: string;
  full_name: string | null;
  email: string | null;
}

export interface TeamWithMembers {
  id: string;
  name: string;
  description: string | null;
  user_id: string;
  members: TeamMemberLite[];
}

export const useTeams = () =>
  useQuery({
    queryKey: ["teams"],
    queryFn: async (): Promise<TeamWithMembers[]> => {
      const { data: teams, error } = await (supabase
        .from("teams" as any)
        .select("id, name, description, user_id")
        .is("deleted_at", null)
        .order("created_at", { ascending: true }) as any);
      if (error) throw error;

      const teamRows = (teams ?? []) as any[];
      const teamIds = teamRows.map((t) => t.id);
      const membersByTeam = new Map<string, TeamMemberLite[]>();

      if (teamIds.length) {
        const { data: tm, error: e2 } = await (supabase
          .from("team_members" as any)
          .select("team_id, member_id")
          .in("team_id", teamIds) as any);
        if (e2) throw e2;

        const memberRows = (tm ?? []) as any[];
        const memberIds = Array.from(new Set(memberRows.map((r) => r.member_id)));
        const profById = new Map<string, any>();
        if (memberIds.length) {
          const { data: profs } = await (supabase
            .from("profiles")
            .select("id, full_name, email")
            .in("id", memberIds) as any);
          for (const p of (profs ?? []) as any[]) profById.set(p.id, p);
        }

        for (const r of memberRows) {
          const arr = membersByTeam.get(r.team_id) ?? [];
          const p = profById.get(r.member_id);
          arr.push({
            member_id: r.member_id,
            full_name: p?.full_name ?? null,
            email: p?.email ?? null,
          });
          membersByTeam.set(r.team_id, arr);
        }
      }

      return teamRows.map((t) => ({
        id: t.id,
        name: t.name,
        description: t.description ?? null,
        user_id: t.user_id,
        members: membersByTeam.get(t.id) ?? [],
      }));
    },
    staleTime: 60 * 1000,
  });

export interface SaveTeamInput {
  id?: string;
  name: string;
  description: string;
  memberIds: string[];
}

export const useSaveTeam = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: SaveTeamInput) => {
      const name = input.name.trim();
      if (!name) throw new Error("Tên đội không được để trống");
      const description = input.description.trim() || null;

      let teamId = input.id;
      if (teamId) {
        const { error } = await (supabase
          .from("teams" as any)
          .update({ name, description })
          .eq("id", teamId) as any);
        if (error) throw error;
      } else {
        const { data, error } = await (supabase
          .from("teams" as any)
          .insert({ name, description } as any)
          .select("id")
          .single() as any);
        if (error) throw error;
        teamId = (data as any).id as string;
      }

      // Diff thành viên (giống useSyncAccountSharedUsers)
      const { data: existing, error: e2 } = await (supabase
        .from("team_members" as any)
        .select("member_id")
        .eq("team_id", teamId) as any);
      if (e2) throw e2;

      const have = new Set(((existing ?? []) as any[]).map((r) => r.member_id as string));
      const want = new Set(input.memberIds);
      const toAdd = input.memberIds.filter((id) => !have.has(id));
      const toRemove = Array.from(have).filter((id) => !want.has(id));

      if (toAdd.length) {
        const { error } = await (supabase
          .from("team_members" as any)
          .insert(toAdd.map((member_id) => ({ team_id: teamId, member_id })) as any) as any);
        if (error) throw error;
      }
      if (toRemove.length) {
        const { error } = await (supabase
          .from("team_members" as any)
          .delete()
          .eq("team_id", teamId)
          .in("member_id", toRemove) as any);
        if (error) throw error;
      }

      return { id: teamId as string };
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["teams"] });
      qc.invalidateQueries({ queryKey: ["staff_users"] });
    },
  });
};

export const useDeleteTeam = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await (supabase
        .from("teams" as any)
        .update({ deleted_at: new Date().toISOString() })
        .eq("id", id) as any);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["teams"] });
      qc.invalidateQueries({ queryKey: ["staff_users"] });
    },
  });
};
