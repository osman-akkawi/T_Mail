import { Router } from "express";
import { EmailService } from "../../services/email";

export function createAssistantRouter(emailService: EmailService) {
  const router = Router();

  router.get("/insights", (req, res, next) => {
    try {
      const user = req.authUser;
      if (!user) {
        res.status(401).json({ ok: false, error: "Unauthorized" });
        return;
      }

      const insights = emailService.getMailButlerInsights(user);
      res.json({ ok: true, data: { insights } });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
