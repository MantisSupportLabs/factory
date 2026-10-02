import ERPShell from "./erp/ERPShell";
import { AccessBoundary } from "./erp/Access";
export default function App() {
  return (
    <AccessBoundary>
      <ERPShell />
    </AccessBoundary>
  );
}
