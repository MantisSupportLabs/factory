import { useMemo, useState, type FormEvent } from "react";
import { api } from "../api/client";
import { useCanEdit } from "./permissions";
import { type Crew, type ERPData, type Person, number, today } from "./types";
import { Badge, Empty, Field, Modal, SectionHead } from "./ui";

const roles = [
  "owner",
  "pm",
  "super",
  "foreman",
  "operator",
  "laborer",
  "driver",
  "mechanic",
  "administrator",
];
const readable = (value: string) =>
  value === "pm"
    ? "Project manager"
    : value === "super"
      ? "Superintendent"
      : value.replaceAll("_", " ").replace(/\b\w/g, (c) => c.toUpperCase());
const errorText = (error: unknown) =>
  error instanceof Error
    ? error.message
    : "Something went wrong. Please try again.";
function certifications(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed.map(String);
  } catch {
    /* Legacy plain-text certifications. */
  }
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}
type PersonForm = {
  id?: number;
  name: string;
  role: string;
  phone: string;
  certs: string;
  active: boolean;
};
type CrewForm = {
  id?: number;
  name: string;
  trade: string;
  foreman_id: string;
  members: number[];
};
type AssignmentForm = {
  crew_id: string;
  jobsite_id: string;
  date: string;
  task: string;
  cost_code: string;
  required_certifications: string;
};

export function Workforce({
  data,
  refresh,
  view,
}: {
  data: ERPData;
  refresh: () => Promise<void>;
  view: "people" | "crews" | "dispatch";
}) {
  const [query, setQuery] = useState("");
  const canEdit = useCanEdit(
    ...(view === "people" ? [] : ["pm", "dispatcher"]),
  );
  const [role, setRole] = useState("all");
  const [dispatchDate, setDispatchDate] = useState(today());
  const [personForm, setPersonForm] = useState<PersonForm | null>(null);
  const [crewForm, setCrewForm] = useState<CrewForm | null>(null);
  const [assignmentForm, setAssignmentForm] = useState<AssignmentForm | null>(
    null,
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [removing, setRemoving] = useState<number | null>(null);
  const people = useMemo(
    () =>
      data.people.filter(
        (person) =>
          (role === "all" || person.role === role) &&
          `${person.name} ${person.role} ${person.crew_name ?? ""} ${person.certs ?? ""}`
            .toLowerCase()
            .includes(query.toLowerCase()),
      ),
    [data.people, query, role],
  );
  const allRoles = [
    ...new Set([...roles, ...data.people.map((person) => person.role)]),
  ];
  const dateAssignments = data.assignments.filter(
    (assignment) => assignment.date === dispatchDate,
  );
  const activePeople = data.people.filter((person) => person.active);

  function startPerson(person?: Person) {
    setError("");
    setSuccess("");
    setPersonForm(
      person
        ? {
            id: person.id,
            name: person.name,
            role: person.role,
            phone: person.phone ?? "",
            certs: certifications(person.certs).join(", "),
            active: Boolean(person.active),
          }
        : { name: "", role: "operator", phone: "", certs: "", active: true },
    );
  }
  function startCrew(crew?: Crew) {
    setError("");
    setSuccess("");
    setCrewForm(
      crew
        ? {
            id: crew.id,
            name: crew.name,
            trade: crew.trade,
            foreman_id: String(crew.foreman_id ?? ""),
            members: [...crew.members],
          }
        : { name: "", trade: "Earthwork", foreman_id: "", members: [] },
    );
  }
  function startAssignment(crew?: Crew) {
    setError("");
    setSuccess("");
    setAssignmentForm({
      crew_id: crew ? String(crew.id) : "",
      jobsite_id: "",
      date: dispatchDate,
      task: "",
      cost_code: "",
      required_certifications: "",
    });
  }
  async function savePerson(event: FormEvent) {
    event.preventDefault();
    if (!personForm) return;
    setSaving(true);
    setError("");
    try {
      const payload = {
        name: personForm.name.trim(),
        role: personForm.role,
        phone: personForm.phone.trim() || null,
        certs: personForm.certs
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean),
        active: personForm.active,
      };
      if (personForm.id)
        await api.patch(`/erp/people/${personForm.id}`, payload);
      else await api.post("/erp/people", payload);
      setPersonForm(null);
      setSuccess(personForm.id ? "Person updated." : "Person added.");
      try {
        await refresh();
      } catch (refreshError) {
        setError(
          `Saved successfully, but the roster could not refresh: ${errorText(refreshError)}`,
        );
      }
    } catch (saveError) {
      setError(errorText(saveError));
    } finally {
      setSaving(false);
    }
  }
  async function saveCrew(event: FormEvent) {
    event.preventDefault();
    if (!crewForm) return;
    setSaving(true);
    setError("");
    try {
      const payload = {
        name: crewForm.name.trim(),
        trade: crewForm.trade.trim(),
        foreman_id: crewForm.foreman_id ? Number(crewForm.foreman_id) : null,
        members: crewForm.members,
      };
      if (crewForm.id) await api.patch(`/erp/crews/${crewForm.id}`, payload);
      else await api.post("/erp/crews", payload);
      setCrewForm(null);
      setSuccess(crewForm.id ? "Crew updated." : "Crew created.");
      try {
        await refresh();
      } catch (refreshError) {
        setError(
          `Saved successfully, but crews could not refresh: ${errorText(refreshError)}`,
        );
      }
    } catch (saveError) {
      setError(errorText(saveError));
    } finally {
      setSaving(false);
    }
  }
  async function saveAssignment(event: FormEvent) {
    event.preventDefault();
    if (!assignmentForm) return;
    setSaving(true);
    setError("");
    try {
      await api.post("/erp/assignments", {
        ...assignmentForm,
        crew_id: Number(assignmentForm.crew_id),
        jobsite_id: Number(assignmentForm.jobsite_id),
        task: assignmentForm.task.trim(),
        cost_code: assignmentForm.cost_code.trim(),
        required_certifications: assignmentForm.required_certifications
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean),
      });
      setDispatchDate(assignmentForm.date);
      setAssignmentForm(null);
      setSuccess("Crew dispatched.");
      try {
        await refresh();
      } catch (refreshError) {
        setError(
          `Saved successfully, but dispatch could not refresh: ${errorText(refreshError)}`,
        );
      }
    } catch (saveError) {
      setError(errorText(saveError));
    } finally {
      setSaving(false);
    }
  }
  async function removeAssignment(id: number) {
    setRemoving(id);
    setError("");
    setSuccess("");
    try {
      await api.del(`/erp/assignments/${id}`);
      setSuccess("Assignment removed.");
      try {
        await refresh();
      } catch (refreshError) {
        setError(
          `Removed successfully, but dispatch could not refresh: ${errorText(refreshError)}`,
        );
      }
    } catch (removeError) {
      setError(errorText(removeError));
    } finally {
      setRemoving(null);
    }
  }

  const crewMembers = (crew: Crew) =>
    data.people.filter((person) => crew.members.includes(person.id));
  const title =
    view === "people" ? "People" : view === "crews" ? "Crews" : "Crew dispatch";
  const description =
    view === "people"
      ? "One roster for project managers, foremen, operators, and support."
      : view === "crews"
        ? "Build trade crews, assign a foreman, and keep membership clear."
        : "Plan who goes where, with one crew assignment per day.";
  return (
    <div className="erp-stack">
      <SectionHead
        title={title}
        description={description}
        action={
          <button
            className="erp-button primary"
            onClick={() =>
              view === "people"
                ? startPerson()
                : view === "crews"
                  ? startCrew()
                  : startAssignment()
            }
            disabled={
              !canEdit ||
              (view === "dispatch" &&
                (!data.crews.length || !data.projects.length))
            }
          >
            +{" "}
            {view === "people"
              ? "Add person"
              : view === "crews"
                ? "Create crew"
                : "Assign crew"}
          </button>
        }
      />
      {error && !personForm && !crewForm && !assignmentForm && (
        <div className="erp-alert error" role="alert">
          {error}
        </div>
      )}
      {success && (
        <div className="erp-alert success" role="status">
          {success}
        </div>
      )}
      <div className="erp-metrics">
        <div className="erp-metric">
          <span>Active people</span>
          <strong>{number(activePeople.length)}</strong>
          <small>{data.people.length - activePeople.length} inactive</small>
        </div>
        <div className="erp-metric">
          <span>Field crews</span>
          <strong>{number(data.crews.length)}</strong>
          <small>
            {activePeople.filter((person) => person.crew_id !== null).length}{" "}
            people on crews
          </small>
        </div>
        <div className="erp-metric">
          <span>
            {view === "dispatch"
              ? "Assigned on selected day"
              : "Crews working today"}
          </span>
          <strong>
            {
              new Set(
                data.assignments
                  .filter(
                    (assignment) =>
                      assignment.date ===
                      (view === "dispatch" ? dispatchDate : today()),
                  )
                  .map((assignment) => assignment.crew_id),
              ).size
            }
          </strong>
          <small>Across active job sites</small>
        </div>
      </div>

      {view === "people" && (
        <section className="erp-card">
          <div className="erp-toolbar">
            <Field label="Search people">
              <input
                type="search"
                placeholder="Name, crew, certification…"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </Field>
            <Field label="Role">
              <select
                value={role}
                onChange={(event) => setRole(event.target.value)}
              >
                <option value="all">All roles</option>
                {allRoles.map((item) => (
                  <option key={item} value={item}>
                    {readable(item)}
                  </option>
                ))}
              </select>
            </Field>
            <span className="erp-muted">{people.length} people</span>
          </div>
          {people.length ? (
            <div className="erp-table-wrap">
              <table className="erp-table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Role</th>
                    <th>Crew</th>
                    <th>Contact</th>
                    <th>Certifications</th>
                    <th>Status</th>
                    <th>
                      <span className="erp-muted">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {people.map((person) => (
                    <tr key={person.id}>
                      <td>
                        <strong>{person.name}</strong>
                      </td>
                      <td>{readable(person.role)}</td>
                      <td>{person.crew_name ?? "Unassigned"}</td>
                      <td>
                        {person.phone ? (
                          <a href={`tel:${person.phone}`}>{person.phone}</a>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td>{certifications(person.certs).join(" · ") || "—"}</td>
                      <td>
                        <Badge tone={person.active ? "success" : "neutral"}>
                          {person.active ? "Active" : "Inactive"}
                        </Badge>
                      </td>
                      <td>
                        <button
                          className="erp-button"
                          aria-label={`Edit ${person.name}`}
                          onClick={() => startPerson(person)}
                          disabled={!canEdit}
                        >
                          Edit
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty>
              {query || role !== "all"
                ? "No people match these filters."
                : "Add your first person to build the company roster."}
            </Empty>
          )}
        </section>
      )}

      {view === "crews" && (
        <div className="erp-grid">
          {data.crews.map((crew) => {
            const members = crewMembers(crew);
            const assignment = data.assignments.find(
              (item) => item.crew_id === crew.id && item.date === today(),
            );
            return (
              <section className="erp-card" key={crew.id}>
                <SectionHead
                  title={crew.name}
                  description={crew.trade}
                  action={
                    <button
                      className="erp-button"
                      aria-label={`Edit ${crew.name}`}
                      onClick={() => startCrew(crew)}
                      disabled={!canEdit}
                    >
                      Edit crew
                    </button>
                  }
                />
                <p>
                  <strong>Foreman:</strong>{" "}
                  {crew.foreman_name ?? "Not assigned"}
                </p>
                <p>
                  <Badge tone={assignment ? "success" : "neutral"}>
                    {assignment ? "Dispatched today" : "Available today"}
                  </Badge>{" "}
                  {assignment?.jobsite_name}
                </p>
                {assignment && (
                  <p className="erp-muted">
                    {assignment.task || "Task not specified"}
                    {assignment.cost_code ? ` · ${assignment.cost_code}` : ""}
                  </p>
                )}
                <h3>{members.length} crew members</h3>
                {members.length ? (
                  <div className="erp-stack">
                    {members.map((person) => (
                      <div className="erp-list-row" key={person.id}>
                        <strong>{person.name}</strong>
                        <span className="erp-muted">
                          {readable(person.role)}
                          {!person.active ? " · Inactive" : ""}
                        </span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="erp-muted">
                    Add members to make this crew ready for dispatch.
                  </p>
                )}
              </section>
            );
          })}
          {!data.crews.length && (
            <Empty>
              Create a crew, choose its foreman, and add people from the roster.
            </Empty>
          )}
        </div>
      )}

      {view === "dispatch" && (
        <>
          <div className="erp-toolbar">
            <Field label="Dispatch date">
              <input
                type="date"
                required
                value={dispatchDate}
                onChange={(event) =>
                  setDispatchDate(event.target.value || today())
                }
              />
            </Field>
            <button
              className="erp-button"
              onClick={() => setDispatchDate(today())}
            >
              Today
            </button>
            <span className="erp-muted">
              {dateAssignments.length} assignments ·{" "}
              {
                data.crews.filter(
                  (crew) =>
                    !dateAssignments.some((item) => item.crew_id === crew.id),
                ).length
              }{" "}
              crews available
            </span>
          </div>
          <div className="erp-grid">
            {data.crews.map((crew) => {
              const assignments = dateAssignments.filter(
                (item) => item.crew_id === crew.id,
              );
              const members = crewMembers(crew);
              return (
                <section className="erp-card" key={crew.id}>
                  <SectionHead
                    title={crew.name}
                    description={`${crew.trade} · ${members.length} people`}
                    action={
                      <Badge tone={assignments.length ? "success" : "neutral"}>
                        {assignments.length ? "Assigned" : "Available"}
                      </Badge>
                    }
                  />
                  <p>
                    <strong>Foreman:</strong>{" "}
                    {crew.foreman_name ?? "Unassigned"}
                  </p>
                  {assignments.length ? (
                    assignments.map((assignment) => (
                      <div
                        className="erp-dispatch-assignment"
                        key={assignment.id}
                      >
                        <h3>{assignment.jobsite_name}</h3>
                        <p>{assignment.task || "Task not specified"}</p>
                        <p className="erp-muted">
                          Cost code: {assignment.cost_code || "Unspecified"}
                        </p>
                        <button
                          className="erp-button"
                          disabled={!canEdit || removing !== null}
                          onClick={() => void removeAssignment(assignment.id)}
                        >
                          {removing === assignment.id
                            ? "Removing…"
                            : "Remove assignment"}
                        </button>
                      </div>
                    ))
                  ) : (
                    <>
                      <p className="erp-muted">
                        No job assigned for this date.
                      </p>
                      <button
                        className="erp-button"
                        disabled={!canEdit || !data.projects.length}
                        onClick={() => startAssignment(crew)}
                      >
                        Assign to a job
                      </button>
                    </>
                  )}
                  <p className="erp-muted">
                    {members.map((person) => person.name).join(", ") ||
                      "No members assigned"}
                  </p>
                </section>
              );
            })}
          </div>
          {!data.crews.length && (
            <Empty>Create crews before planning field assignments.</Empty>
          )}
        </>
      )}

      {personForm && (
        <Modal
          title={personForm.id ? "Edit person" : "Add person"}
          onClose={() => {
            if (!saving) {
              setPersonForm(null);
              setError("");
            }
          }}
        >
          <form onSubmit={savePerson}>
            <fieldset className="erp-form-fields" disabled={saving}>
              <div className="erp-form-grid">
                <Field label="Full name">
                  <input
                    required
                    maxLength={150}
                    value={personForm.name}
                    onChange={(event) =>
                      setPersonForm({ ...personForm, name: event.target.value })
                    }
                  />
                </Field>
                <Field label="Role">
                  <select
                    value={personForm.role}
                    onChange={(event) =>
                      setPersonForm({ ...personForm, role: event.target.value })
                    }
                  >
                    {allRoles.map((item) => (
                      <option key={item} value={item}>
                        {readable(item)}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Phone">
                  <input
                    type="tel"
                    maxLength={50}
                    value={personForm.phone}
                    onChange={(event) =>
                      setPersonForm({
                        ...personForm,
                        phone: event.target.value,
                      })
                    }
                  />
                </Field>
                <Field label="Certifications, separated by commas">
                  <input
                    placeholder="OSHA 30, CDL, Trench safety"
                    value={personForm.certs}
                    onChange={(event) =>
                      setPersonForm({
                        ...personForm,
                        certs: event.target.value,
                      })
                    }
                  />
                </Field>
                <label className="erp-checkbox">
                  <input
                    type="checkbox"
                    checked={personForm.active}
                    onChange={(event) =>
                      setPersonForm({
                        ...personForm,
                        active: event.target.checked,
                      })
                    }
                  />{" "}
                  Active employee
                </label>
              </div>
              {error && (
                <div className="erp-alert error" role="alert">
                  {error}
                </div>
              )}
              <div className="erp-form-actions">
                <button
                  type="button"
                  className="erp-button"
                  disabled={saving}
                  onClick={() => {
                    setPersonForm(null);
                    setError("");
                  }}
                >
                  Cancel
                </button>
                <button
                  className="erp-button primary"
                  disabled={saving || !personForm.name.trim()}
                >
                  {saving ? "Saving…" : "Save person"}
                </button>
              </div>
            </fieldset>
          </form>
        </Modal>
      )}

      {crewForm && (
        <Modal
          title={crewForm.id ? "Edit crew" : "Create crew"}
          onClose={() => {
            if (!saving) {
              setCrewForm(null);
              setError("");
            }
          }}
        >
          <form onSubmit={saveCrew}>
            <fieldset className="erp-form-fields" disabled={saving}>
              <div className="erp-form-grid">
                <Field label="Crew name">
                  <input
                    required
                    maxLength={150}
                    value={crewForm.name}
                    onChange={(event) =>
                      setCrewForm({ ...crewForm, name: event.target.value })
                    }
                  />
                </Field>
                <Field label="Trade">
                  <input
                    required
                    maxLength={100}
                    list="erp-trades"
                    value={crewForm.trade}
                    onChange={(event) =>
                      setCrewForm({ ...crewForm, trade: event.target.value })
                    }
                  />
                  <datalist id="erp-trades">
                    <option value="Earthwork" />
                    <option value="Underground utilities" />
                    <option value="Roads and paving" />
                    <option value="Concrete" />
                    <option value="Support" />
                  </datalist>
                </Field>
                <Field label="Foreman">
                  <select
                    required
                    value={crewForm.foreman_id}
                    onChange={(event) => {
                      const id = event.target.value;
                      setCrewForm({
                        ...crewForm,
                        foreman_id: id,
                        members: id
                          ? [...new Set([...crewForm.members, Number(id)])]
                          : crewForm.members,
                      });
                    }}
                  >
                    <option value="">Choose qualified foreman</option>
                    {activePeople
                      .filter(
                        (person) =>
                          /foreman|super/i.test(person.role) &&
                          (person.crew_id === null ||
                            person.crew_id === crewForm.id ||
                            person.id === Number(crewForm.foreman_id)),
                      )
                      .map((person) => (
                        <option key={person.id} value={person.id}>
                          {person.name}
                        </option>
                      ))}
                  </select>
                </Field>
              </div>
              <fieldset className="erp-member-picker">
                <legend>Crew members ({crewForm.members.length})</legend>
                <p className="erp-muted">
                  People already on another crew are unavailable. The foreman is
                  included in the crew.
                </p>
                {data.people.length ? (
                  data.people
                    .filter(
                      (person) =>
                        person.active || crewForm.members.includes(person.id),
                    )
                    .map((person) => {
                      const elsewhere =
                        person.crew_id !== null &&
                        person.crew_id !== crewForm.id;
                      const foreman = person.id === Number(crewForm.foreman_id);
                      return (
                        <label className="erp-checkbox" key={person.id}>
                          <input
                            type="checkbox"
                            checked={crewForm.members.includes(person.id)}
                            disabled={elsewhere || foreman}
                            onChange={(event) =>
                              setCrewForm({
                                ...crewForm,
                                members: event.target.checked
                                  ? [...crewForm.members, person.id]
                                  : crewForm.members.filter(
                                      (id) => id !== person.id,
                                    ),
                              })
                            }
                          />
                          <span>
                            {person.name}{" "}
                            <span className="erp-muted">
                              · {readable(person.role)}
                              {elsewhere
                                ? ` · ${person.crew_name ?? "Another crew"}`
                                : foreman
                                  ? " · Foreman"
                                  : ""}
                            </span>
                          </span>
                        </label>
                      );
                    })
                ) : (
                  <p>Add people to the roster first.</p>
                )}
              </fieldset>
              {error && (
                <div className="erp-alert error" role="alert">
                  {error}
                </div>
              )}
              <div className="erp-form-actions">
                <button
                  type="button"
                  className="erp-button"
                  disabled={saving}
                  onClick={() => {
                    setCrewForm(null);
                    setError("");
                  }}
                >
                  Cancel
                </button>
                <button
                  className="erp-button primary"
                  disabled={
                    saving ||
                    !crewForm.name.trim() ||
                    !crewForm.trade.trim() ||
                    !crewForm.foreman_id
                  }
                >
                  {saving ? "Saving…" : "Save crew"}
                </button>
              </div>
            </fieldset>
          </form>
        </Modal>
      )}

      {assignmentForm && (
        <Modal
          title="Assign crew to a job"
          onClose={() => {
            if (!saving) {
              setAssignmentForm(null);
              setError("");
            }
          }}
        >
          <form onSubmit={saveAssignment}>
            <fieldset className="erp-form-fields" disabled={saving}>
              <div className="erp-form-grid">
                <Field label="Crew">
                  <select
                    required
                    value={assignmentForm.crew_id}
                    onChange={(event) =>
                      setAssignmentForm({
                        ...assignmentForm,
                        crew_id: event.target.value,
                      })
                    }
                  >
                    <option value="">Choose crew</option>
                    {data.crews.map((crew) => (
                      <option key={crew.id} value={crew.id}>
                        {crew.name}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Job site">
                  <select
                    required
                    value={assignmentForm.jobsite_id}
                    onChange={(event) =>
                      setAssignmentForm({
                        ...assignmentForm,
                        jobsite_id: event.target.value,
                      })
                    }
                  >
                    <option value="">Choose job site</option>
                    {data.projects.map((project) => (
                      <option key={project.id} value={project.id}>
                        {project.code} · {project.name}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Date">
                  <input
                    type="date"
                    required
                    value={assignmentForm.date}
                    onChange={(event) =>
                      setAssignmentForm({
                        ...assignmentForm,
                        date: event.target.value,
                      })
                    }
                  />
                </Field>
                <Field label="Cost code">
                  <input
                    required
                    maxLength={80}
                    placeholder="e.g. 02-110"
                    value={assignmentForm.cost_code}
                    onChange={(event) =>
                      setAssignmentForm({
                        ...assignmentForm,
                        cost_code: event.target.value,
                      })
                    }
                  />
                </Field>
                <Field label="Required dated qualifications (optional)" wide>
                  <input
                    value={assignmentForm.required_certifications}
                    maxLength={1500}
                    placeholder="Trench safety, CDL"
                    onChange={(event) =>
                      setAssignmentForm({
                        ...assignmentForm,
                        required_certifications: event.target.value,
                      })
                    }
                  />
                  <small>
                    Separate names with commas. Every scheduled member must hold
                    each qualification on the work date.
                  </small>
                </Field>
                <Field label="Planned task" wide>
                  <textarea
                    required
                    maxLength={300}
                    rows={3}
                    placeholder="South basin excavation and haul-off"
                    value={assignmentForm.task}
                    onChange={(event) =>
                      setAssignmentForm({
                        ...assignmentForm,
                        task: event.target.value,
                      })
                    }
                  />
                </Field>
              </div>
              {data.assignments.some(
                (item) =>
                  item.crew_id === Number(assignmentForm.crew_id) &&
                  item.date === assignmentForm.date,
              ) && (
                <div className="erp-alert warning">
                  This crew already has an assignment on this date. Remove its
                  existing assignment before dispatching it again.
                </div>
              )}
              {error && (
                <div className="erp-alert error" role="alert">
                  {error}
                </div>
              )}
              <div className="erp-form-actions">
                <button
                  type="button"
                  className="erp-button"
                  disabled={saving}
                  onClick={() => {
                    setAssignmentForm(null);
                    setError("");
                  }}
                >
                  Cancel
                </button>
                <button
                  className="erp-button primary"
                  disabled={
                    saving ||
                    !assignmentForm.task.trim() ||
                    !assignmentForm.cost_code.trim() ||
                    data.assignments.some(
                      (item) =>
                        item.crew_id === Number(assignmentForm.crew_id) &&
                        item.date === assignmentForm.date,
                    )
                  }
                >
                  {saving ? "Assigning…" : "Assign crew"}
                </button>
              </div>
            </fieldset>
          </form>
        </Modal>
      )}
    </div>
  );
}
