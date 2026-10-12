/** Starts a browser download of the supplied XML unchanged; removes the link and later revokes its blob URL. */
export function downloadXml(xml: string, filename = "diagram.drawio"): void {
  const url = URL.createObjectURL(new Blob([xml], { type: "application/vnd.jgraph.mxfile;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  try { link.click(); }
  finally {
    link.remove();
    // Let the browser initiate the download before releasing the blob URL.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
