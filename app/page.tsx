import DiagramWorkspace from "../components/DiagramWorkspace";
import { createEmptyDocument } from "../lib/diagram/document";
export default function Page() {
  return (
    <main>
      <DiagramWorkspace initialXml={createEmptyDocument()} />
    </main>
  );
}
