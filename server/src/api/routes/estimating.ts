import {
  Router,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import {
  approveEstimate,
  createEstimate,
  editEstimate,
  getEstimate,
  getEstimating,
  handoverEstimate,
  reviseEstimate,
} from "../../erp/estimating.js";
import { body, ErpError, id, text } from "../../erp/validation.js";

export const estimatingRouter = Router();
const handle =
  (handler: (req: Request, res: Response) => void) =>
  (req: Request, res: Response, next: NextFunction) => {
    try {
      handler(req, res);
    } catch (error) {
      if (error instanceof ErpError)
        res.status(error.status).json({ error: error.message });
      else if (
        error instanceof Error &&
        /UNIQUE constraint failed/.test(error.message)
      )
        res
          .status(409)
          .json({
            error:
              "This bid code, award, project code, or revision conflicts with an existing record",
          });
      else next(error);
    }
  };
const actor = (req: Request) => req.authUser?.name ?? "Demo user";
estimatingRouter.get(
  "/erp/estimating",
  handle((req, res) => {
    res.json(getEstimating(req.tenant.id));
  }),
);
estimatingRouter.get(
  "/erp/estimates/:id",
  handle((req, res) => {
    res.json(getEstimate(req.tenant.id, id(req.params.id)));
  }),
);
estimatingRouter.post(
  "/erp/estimates",
  handle((req, res) => {
    res.status(201).json(createEstimate(req.tenant.id, req.body, actor(req)));
  }),
);
estimatingRouter.patch(
  "/erp/estimates/:id",
  handle((req, res) => {
    res.json(editEstimate(req.tenant.id, id(req.params.id), req.body));
  }),
);
estimatingRouter.post(
  "/erp/estimates/:id/approve",
  handle((req, res) => {
    const b = body(req.body),
      reviewer =
        req.authUser?.name ??
        (b.reviewer === undefined
          ? "Demo reviewer"
          : text(b.reviewer, "reviewer", true, 150));
    res.json(approveEstimate(req.tenant.id, id(req.params.id), b, reviewer));
  }),
);
estimatingRouter.post(
  "/erp/estimates/:id/revise",
  handle((req, res) => {
    res
      .status(201)
      .json(
        reviseEstimate(req.tenant.id, id(req.params.id), req.body, actor(req)),
      );
  }),
);
estimatingRouter.post(
  "/erp/estimates/:id/handover",
  handle((req, res) => {
    const result = handoverEstimate(
      req.tenant.id,
      id(req.params.id),
      req.body,
      actor(req),
    );
    res.status(result.created ? 201 : 200).json(result.handover);
  }),
);
