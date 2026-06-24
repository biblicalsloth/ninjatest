import { Resend } from "resend";

const resend = new Resend(process.env.RESEND_API_KEY);

const FROM = "Ninjatest <battles@ninjatest.vercel.app>";

export async function sendChallengeInvite({
  to,
  fromUsername,
  code,
  isRated,
  origin,
}: {
  to: string;
  fromUsername: string;
  code: string;
  isRated: boolean;
  origin: string;
}) {
  const link = `${origin}/c/${code}`;
  return resend.emails.send({
    from: FROM,
    to,
    subject: `${fromUsername} challenged you to a CAT battle`,
    html: `
<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#073b4c;font-family:'Geist',Arial,sans-serif;">
  <div style="max-width:480px;margin:40px auto;padding:32px 24px;">
    <div style="text-align:center;margin-bottom:32px;">
      <div style="width:40px;height:40px;border-radius:50%;background:#06d6a0;display:inline-flex;align-items:center;justify-content:center;margin-bottom:12px;">
        <span style="color:#073b4c;font-weight:700;font-size:16px;">N</span>
      </div>
      <h1 style="color:#ffffff;font-size:22px;font-weight:700;margin:0;">Ninjatest</h1>
    </div>

    <div style="background:#0a4f66;border:1px solid #1a6080;border-radius:16px;padding:32px 24px;text-align:center;">
      <p style="color:#7ab5cc;font-size:14px;margin:0 0 8px;">You&rsquo;ve been challenged!</p>
      <h2 style="color:#ffffff;font-size:24px;font-weight:700;margin:0 0 4px;">${fromUsername}</h2>
      <p style="color:#c5e8f0;font-size:14px;margin:0 0 24px;">wants to battle you in a 9-question CAT match</p>

      <div style="background:#073b4c;border-radius:10px;padding:12px 16px;margin-bottom:24px;display:inline-block;">
        <span style="color:${isRated ? "#06d6a0" : "#c5e8f0"};font-size:13px;font-weight:600;">
          ${isRated ? "⚔️ Rated match — ELO on the line" : "🛡️ Unrated practice match"}
        </span>
      </div>

      <div style="margin-bottom:24px;">
        <p style="color:#7ab5cc;font-size:12px;margin:0 0 8px;">9 questions · VARC + DILR + Quant · Synchronized timer</p>
      </div>

      <a href="${link}" style="display:inline-block;background:#06d6a0;color:#073b4c;font-weight:700;font-size:15px;padding:14px 36px;border-radius:100px;text-decoration:none;">
        Accept Challenge
      </a>

      <p style="color:#4a8fa8;font-size:11px;margin:20px 0 0;">Link expires in 15 minutes</p>
    </div>

    <p style="color:#4a8fa8;font-size:11px;text-align:center;margin-top:24px;">
      If you didn&rsquo;t expect this, ignore it.
    </p>
  </div>
</body>
</html>`,
  });
}

export async function sendMatchResult({
  to,
  username,
  opponent,
  myScore,
  oppScore,
  result,
  eloDelta,
  isRated,
  origin,
}: {
  to: string;
  username: string;
  opponent: string;
  myScore: number;
  oppScore: number;
  result: "win" | "loss" | "draw";
  eloDelta: number | null;
  isRated: boolean;
  origin: string;
}) {
  const resultLabel = result === "win" ? "Victory 🏆" : result === "draw" ? "Draw 🤝" : "Defeat 💀";
  const resultColor = result === "win" ? "#06d6a0" : result === "draw" ? "#7ab5cc" : "#ef476f";
  const eloLine = isRated && eloDelta !== null
    ? `<p style="color:${eloDelta >= 0 ? "#06d6a0" : "#ef476f"};font-size:18px;font-weight:700;margin:8px 0 0;">${eloDelta >= 0 ? "+" : ""}${eloDelta} ELO</p>`
    : "";

  return resend.emails.send({
    from: FROM,
    to,
    subject: `Match result: ${resultLabel} vs ${opponent}`,
    html: `
<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#073b4c;font-family:'Geist',Arial,sans-serif;">
  <div style="max-width:480px;margin:40px auto;padding:32px 24px;">
    <div style="text-align:center;margin-bottom:32px;">
      <div style="width:40px;height:40px;border-radius:50%;background:#06d6a0;display:inline-flex;align-items:center;justify-content:center;margin-bottom:12px;">
        <span style="color:#073b4c;font-weight:700;font-size:16px;">N</span>
      </div>
      <h1 style="color:#ffffff;font-size:22px;font-weight:700;margin:0;">Ninjatest</h1>
    </div>

    <div style="background:#0a4f66;border:1px solid #1a6080;border-radius:16px;padding:32px 24px;text-align:center;">
      <h2 style="color:${resultColor};font-size:28px;font-weight:700;margin:0 0 4px;">${resultLabel}</h2>
      <p style="color:#7ab5cc;font-size:14px;margin:0 0 24px;">${username} vs ${opponent}</p>

      <div style="background:#073b4c;border-radius:12px;padding:20px;margin-bottom:24px;">
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <div style="text-align:center;flex:1;">
            <p style="color:#c5e8f0;font-size:12px;margin:0 0 4px;">${username}</p>
            <p style="color:#ffd166;font-size:28px;font-weight:700;margin:0;">${myScore}</p>
          </div>
          <div style="color:#4a8fa8;font-size:14px;font-weight:700;padding:0 16px;">vs</div>
          <div style="text-align:center;flex:1;">
            <p style="color:#c5e8f0;font-size:12px;margin:0 0 4px;">${opponent}</p>
            <p style="color:#ffffff;font-size:28px;font-weight:700;margin:0;">${oppScore}</p>
          </div>
        </div>
        ${eloLine}
      </div>

      <span style="display:inline-block;background:${isRated ? "#06d6a0" : "#0a4f66"};color:${isRated ? "#073b4c" : "#7ab5cc"};font-size:12px;font-weight:600;padding:4px 12px;border-radius:100px;border:1px solid ${isRated ? "transparent" : "#2a7a9a"};">
        ${isRated ? "Rated match" : "Unrated match"}
      </span>

      <div style="margin-top:24px;">
        <a href="${origin}/lobby" style="display:inline-block;background:#073b4c;border:1px solid #2a7a9a;color:#c5e8f0;font-size:14px;font-weight:600;padding:12px 28px;border-radius:100px;text-decoration:none;">
          Play again
        </a>
      </div>
    </div>

    <p style="color:#4a8fa8;font-size:11px;text-align:center;margin-top:24px;">
      Ninjatest · Real-time CAT prep battles
    </p>
  </div>
</body>
</html>`,
  });
}
