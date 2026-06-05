import React from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api } from "../api";
import { EmailViewer } from "../components/EmailViewer";
import { useEmailStore } from "../store/emailStore";
import type { TMailEmail, TMailFolder } from "../types";

const validFolders: TMailFolder[] = ["inbox", "sent", "drafts", "trash", "starred", "spam"];

function resolveFolder(value: string | undefined): TMailFolder {
  if (value && validFolders.includes(value as TMailFolder)) {
    return value as TMailFolder;
  }
  return "inbox";
}

export default function EmailPage() {
  const navigate = useNavigate();
  const { folder: folderParam, id } = useParams();
  const folder = resolveFolder(folderParam);
  const { setComposing, setComposeData, deleteEmail, toggleStar, markRead, moveToSpam, markNotSpam } = useEmailStore();

  const [email, setEmail] = React.useState<TMailEmail | null>(null);
  const [thread, setThread] = React.useState<TMailEmail[]>([]);

  React.useEffect(() => {
    if (!id) {
      return;
    }

    void api.emails.get(folder, id).then((data) => {
      setEmail(data.email);
      setThread(data.thread);
      if (data.email.status === "unread") {
        void markRead(data.email.id);
      }
    });
  }, [folder, id, markRead]);

  if (!email) {
    return <section className="page"><p>Loading email...</p></section>;
  }

  return (
    <section className="page">
      <button type="button" className="link-button" onClick={() => navigate(-1)}>
        ← Back
      </button>
      <EmailViewer
        email={email}
        thread={thread}
        folder={folder}
        onReply={() => {
          setComposeData({
            to: [email.from],
            subject: email.subject.startsWith("Re:") ? email.subject : `Re: ${email.subject}`,
            replyTo: email.id,
          });
          setComposing(true);
        }}
        onDelete={() => {
          void deleteEmail(email.id).then(() => navigate("/"));
        }}
        onToggleStar={() => {
          void toggleStar(email.id).then(async () => {
            const fresh = await api.emails.get(folder, email.id);
            setEmail(fresh.email);
          });
        }}
        onSpam={() => {
          void moveToSpam(email.id).then(() => navigate(-1));
        }}
        onNotSpam={() => {
          markNotSpam(email.id);
          navigate("/spam");
        }}
      />
    </section>
  );
}

