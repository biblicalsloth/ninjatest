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
}

interface Props {
  data: DataPoint[];
}

export function EloGraph({ data }: Props) {
  const chartData = data.map((d, i) => ({
    match: i + 1,
    elo: d.elo,
    delta: d.delta,
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
              backgroundColor: "#0a4f66",
              border: "1px solid #2a7a9a",
              borderRadius: 8,
              color: "#ffffff",
              fontSize: 12,
            }}
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            formatter={(value: any, name: any) => {
              if (name === "elo") return [`${value} ELO`, "Rating"];
              return [value > 0 ? `+${value}` : value, "Change"];
            }}
            labelFormatter={(label) => `Match ${label}`}
          />
          <ReferenceLine y={1000} stroke="#2a7a9a" strokeDasharray="3 3" />
          <Line
            type="monotone"
            dataKey="elo"
            stroke="#06d6a0"
            strokeWidth={2}
            dot={false}
            activeDot={{ r: 4, fill: "#06d6a0", stroke: "#000000", strokeWidth: 2 }}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
