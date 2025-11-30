import { css } from "typesafecss";

export const redButton = css.hsl(0, 75, 50).bord(1, "hsl(0, 75%, 75%)").background("hsl(0, 75%, 75%)", "hover");
export const yellowButton = css.hsl(50, 90, 50).bord(1, "hsl(40, 75%, 75%)").color("hsl(0, 0%, 16%)!important").background("hsl(40, 75%, 75%)", "hover");
export const greenButton = css.hsl(110, 65, 45).bord(1, { h: 110, s: 65, l: 75 }).background("hsl(110, 65%, 90%)", "hover");

export const errorMessage = css.hsl(0, 75, 50).color("white")
    .padding("4px 6px", "soft")
    .whiteSpace("pre-wrap").display("inline-block", "soft")
    ;
export const warnMessage = css.hsl(50, 75, 50).color("hsl(0, 0%, 7%)", "important", "soft")
    .padding("4px 6px", "soft")
    .whiteSpace("pre-wrap").display("inline-block", "soft")
    ;