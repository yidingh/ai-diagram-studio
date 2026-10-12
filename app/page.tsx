import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import DiagramWorkspace from '../components/DiagramWorkspace';
import { createEmptyDocument } from '../lib/diagram/xml';

/** Server Component: prepares empty startup XML and a development-only fixture for the client workspace. */
export default function Page() {
  const demoXml = process.env.NODE_ENV === 'development'
    ? readFileSync(join(process.cwd(), 'tests/fixtures/three-node.drawio'), 'utf8') : undefined;
  return <main>
    <h1>Diagram editor</h1>
    <p>Describe a small architecture, review its candidate, then Apply.</p>
    <DiagramWorkspace initialXml={createEmptyDocument()} demoXml={demoXml}/>
  </main>;
}
