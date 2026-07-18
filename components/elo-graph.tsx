"use client";

import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
} from "recharts";

interface DataPoint {
  elo: number;
  at: string;
  delta: number;
  /** true = season soft-reset row (rating_history.match_id is null), not a match */
  reset?: boolean;
}

interface Props {
  data: DataPoint[];
}

export function EloGraph({ data }: Props) {
  const chartData = data.map((d, i) => ({
    match: i + 1,
    elo: d.elo,
    delta: d.delta,
    reset: d.reset ?? false,
    date: new Date(d.at).toLocaleDateString(),
  }));

  const minElo = Math.min(...data.map((d) => d.elo));
  const maxElo = Math.max(...data.map((d) => d.elo));
  const padding = Math.max(50, (maxElo - minElo) * 0.2);

  return (
    <div className="h-48">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={chartData} margin={{ top: 4, right: 4, left: -20, bottom: 0 }}>
          <XAxis
            dataKey="match"
            tick={{ fill: "#7ab5cc", fontSize: 11 }}
            axisLine={false}
            tickLine={false}
            label={{ value: "Match #", position: "insideBottom", offset: -2, fill: "#4a8fa8", fontSize: 10 }}
          />
          <YAxis
            domain={[minElo - padding, maxElo + padding]}
            tick={{ fill: "#7ab5cc", fontSize: 11 }}
            axisLine={false}
            tickLine={false}
          />
          <Tooltip
            contentStyle={{
              backgroundColor: "#111111",
              border: "1px solid #222222",
              borderRadius: 8,
              color: "#ffffff",
              fontSize: 12,
            }}
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            formatter={(value: any, name: any, item: any) => {
              if (name === "elo") return [`${value} ELO`, "Rating"];
              if (item?.payload?.reset) return [`${value}`, "Season reset"];
              return [value > 0 ? `+${value}` : value, "Change"];
            }}
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            labelFormatter={(label: any, payload: any) =>
              payload?.[0]?.payload?.reset ? "Season reset" : `Match ${label}`
            }
          />
          <ReferenceLine y={1000} stroke="#333333" strokeDasharray="3 3" />
          <Line
            type="monotone"
            dataKey="elo"
            stroke="#06d6a0"
            strokeWidth={2}
            // Season-reset points get a gold marker so the drop reads as a
            // reset, not a catastrophic loss.
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            dot={(props: any) => {
              const { cx, cy, payload, index } = props;
              if (!payload?.reset) return <g key={index} />;
              return (
                <circle key={index} cx={cx} cy={cy} r={4} fill="#ffd166" stroke="#120F17" strokeWidth={2} />
              );
            }}
            activeDot={{ r: 4, fill: "#06d6a0", stroke: "#120F17", strokeWidth: 2 }}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
