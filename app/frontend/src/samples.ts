/** A Classifier fed by a detector with several boxes works on one picture per box: "part.png#2" is box 2 of part.png. */
export function sampleLabel(frame: string): string {
  const m = /^(.+)#(\d{1,2})$/.exec(frame);
  return m ? `${m[1]} · box ${m[2]}` : frame;
}
