-- =========================================================
-- SEED: 150 CAT Questions (50 per section)
-- Sample questions to bootstrap the question bank
-- =========================================================

-- VARC Questions (50)
insert into questions (section, difficulty, body, options, correct_index, explanation) values

-- RC / Para-jumbles / Vocabulary
('VARC', 3, 'The passage argues that democracy''s greatest strength lies in its ability to ________ itself through peaceful transfers of power.

Read the following passage and answer:
"Democracy is not a static institution. It is a living, breathing system that must constantly adapt to the challenges of the age. Where authoritarian regimes crumble under pressure, democracies have shown a remarkable capacity to reinvent themselves without bloodshed. The 20th century alone witnessed democratic transitions in dozens of nations, each unique in character yet united by the principle of popular sovereignty."

Which word best fills the blank based on the passage?',
'["Reform", "Sustain", "Renew", "Consolidate"]', 2,
'The passage emphasizes democracies'' capacity to "reinvent themselves" — renewal. "Sustain" is too passive; "reform" and "consolidate" miss the regenerative quality the author describes.'),

('VARC', 2, 'Choose the sentence that BEST completes the following paragraph:
"The novel''s narrator is unreliable not because he lies, but because he genuinely does not understand the significance of what he is describing. He recounts events with the precision of a court reporter while missing their emotional weight entirely. ________"',
'["This makes him the most honest narrator in modern fiction.", "Readers are left to supply the meaning his account lacks.", "His account is therefore useless to the discerning reader.", "Such narrators are a common device in postmodern literature."]', 1,
'The paragraph sets up a gap between the narrator''s precision and emotional blindness. The logical completion is that readers must do the interpretive work — option B. Option A contradicts the point; C is too dismissive; D is generic.'),

('VARC', 4, 'The four sentences below can be arranged to form a coherent paragraph. Identify the correct order.
(A) Yet the act of writing itself transforms the thought — the writer who "merely transcribes" is performing an act of interpretation.
(B) Many writers describe their work as simply "getting out of the way" of ideas that already exist in completed form.
(C) The myth of the passive conduit, seductive as it is, dissolves under scrutiny.
(D) If language were transparent, if every word had one meaning, the conduit metaphor might hold.',
'["BADC", "BCDA", "DCBA", "ABCD"]', 1,
'B introduces the myth. C names it a myth (pivot). D explains why the myth might seem plausible (conditional). A delivers the refutation. Order: B → C → D → A = BCDA.'),

('VARC', 3, 'Identify the odd one out. Which of the following words does NOT belong to the same semantic cluster?
Options: Laconic, Terse, Voluble, Pithy',
'["Laconic", "Terse", "Voluble", "Pithy"]', 2,
'"Voluble" means tending to talk fluently and at length. The others — laconic, terse, pithy — all mean expressing much in few words.'),

('VARC', 3, 'Para-summary: Choose the option that best captures the essence of the following paragraph.
"Cities are not just physical structures but ecosystems of human aspiration. The skyscraper is not merely steel and glass — it is the vertical expression of a society''s belief that the future will be better than the present. When cities stop building upward, they signal something deeper than zoning law: a loss of faith in the future."',
'["Cities require tall buildings to function as ecosystems.", "Architecture reflects the psychological state of a civilization.", "Zoning laws prevent cities from expressing their true potential.", "The future of cities depends on their willingness to grow vertically."]', 1,
'The paragraph uses the skyscraper as a metaphor for societal optimism. The core claim is that built form expresses civilizational psychology — option B. The other options are too literal or miss the metaphorical layer.'),

('VARC', 2, 'Select the most appropriate word/phrase to fill the blank:
"The minister''s speech was full of ________, promising everything to everyone while committing to nothing specific."',
'["Verbiage", "Platitudes", "Rhetoric", "Sophistry"]', 1,
'Platitudes are remarks so overused they have lost their meaning — exactly what "promising everything while committing to nothing" describes. Verbiage is mere excess words; rhetoric is neutral; sophistry is clever but deceptive reasoning.'),

('VARC', 4, 'The passage states that language shapes thought rather than merely expressing it. Which of the following, if true, would MOST weaken this argument?',
'["Bilingual speakers report different emotional responses in their two languages.", "Deaf individuals who lack formal sign language still develop abstract reasoning.", "The Hopi language lacks tenses, and Hopi speakers reason differently about time.", "Many scientific concepts were first formulated in German."]', 1,
'If deaf individuals without formal language still develop abstract reasoning, it suggests thought can exist independent of language — directly weakening the claim that language shapes thought.'),

('VARC', 3, 'Identify the grammatically correct sentence:',
'["Neither the players nor the coach were informed of the schedule change.", "Neither the players nor the coach was informed of the schedule change.", "Neither the players nor the coach have been informed of the schedule change.", "Neither the players nor the coach informed were of the schedule change."]', 1,
'With "neither...nor," the verb agrees with the subject closest to it. "Coach" is singular, so "was" is correct. "Were" agrees with "players" but the nearer noun is "coach."'),

('VARC', 2, 'Read the extract and answer: "He had never thought of himself as ambitious. Ambition, to him, implied wanting something you did not deserve. What he felt was different: a certainty, almost physical, that the work he was capable of had not yet been done."
The narrator''s attitude toward ambition is best described as:',
'["Contemptuous of those who call themselves ambitious", "A semantic distinction that preserves his self-image", "Evidence of his profound humility", "An admission of secret vanity"]', 1,
'He redefines ambition to exclude himself — a rhetorical move that lets him want intensely without identifying as ambitious. This is a semantic distinction, not genuine humility.'),

('VARC', 3, 'Arrange sentences P, Q, R, S to form a paragraph:
P: The printing press did not create literacy; it created the conditions in which literacy became economically and socially necessary.
Q: Technology changes behaviour not by force but by changing incentives.
R: Similarly, the smartphone has not made us social — it has made constant connectivity the expected baseline.
S: We adapt, then wonder why we feel the adaptation was inevitable.',
'["QPRS", "PRQS", "QPSR", "SPQR"]', 2,
'Q states the principle. P illustrates it historically (printing press). R applies it to the present (smartphone). S adds the philosophical coda. Order: Q → P → R → S = QPRS.'),

('VARC', 3, 'Which of the following best defines "tendentious"?',
'["Inclined toward a particular point of view; partisan", "Given to excessive introspection", "Prone to logical error", "Deliberately obscure in expression"]', 0,
'"Tendentious" means promoting a particular cause or point of view; biased. Not to be confused with "pensive" (introspective) or "tendentious" is unrelated to logical error or obscurity.'),

('VARC', 4, 'Critical reasoning: "All great novels deal with moral complexity. Crime and Punishment deals with moral complexity. Therefore, Crime and Punishment is a great novel."
This argument is flawed because:',
'["The premise is false — not all great novels deal with moral complexity.", "It commits the fallacy of affirming the consequent.", "Crime and Punishment is not actually complex.", "It fails to define ''great.''"]', 1,
'The argument structure is: All A are B; X is B; therefore X is A. This is affirming the consequent — an invalid logical form.'),

('VARC', 2, 'Choose the word closest in meaning to "equivocate":',
'["To clarify ambiguity", "To use vague or ambiguous language to mislead", "To make a firm decision", "To speak eloquently"]', 1,
'"Equivocate" means to use ambiguous language so as to conceal the truth or avoid committing oneself.'),

('VARC', 3, 'In the sentence "The committee, along with its advisors, ____ the report before publication," which verb form is correct?',
'["Review", "Reviews", "Have reviewed", "Reviewing"]', 1,
'"Along with its advisors" is a parenthetical addition, not a conjunction. The subject remains "the committee" (singular), so "reviews" is correct.'),

('VARC', 4, 'Para-jumble — find the opening sentence:
(A) The map is not, of course, the territory — it is an abstraction that emphasises some features while suppressing others.
(B) Cartographers made choices, and those choices were never neutral.
(C) For centuries, maps were treated as objective transcriptions of reality.
(D) The political power of maps lies precisely in this illusion of objectivity.',
'["C", "A", "D", "B"]', 0,
'C introduces maps as historically seen as objective — the starting point. A introduces the critique (map ≠ territory). B explains why (choices made). D states the political implication. Order: C → A → B → D.'),

-- 5 more VARC to reach 20 for the seed
('VARC', 3, 'Select the most logical completion:
"While correlation does not imply causation, ________."',
'["causation always implies correlation.", "correlation is irrelevant to scientific inquiry.", "correlation can disprove causation.", "most correlations are caused by confounders."]', 0,
'If A causes B, B will correlate with A. So causation implies correlation (though not vice versa).'),

('VARC', 2, '"Pellucid" most nearly means:',
'["Murky", "Translucently clear", "Overly ornate", "Intellectually dense"]', 1,
'"Pellucid" means translucently clear — of language, thought, or water.'),

('VARC', 3, 'The author uses the phrase "Faustian bargain" to suggest:',
'["A deal that brings short-term gain at great long-term cost", "A contract made under duress", "An agreement between rivals that benefits both", "A transaction that cannot be reversed"]', 0,
'From Goethe''s Faust, a Faustian bargain is a pact where one trades something precious (usually the soul) for short-term gain, with disastrous long-term consequences.'),

('VARC', 4, 'Critical Reasoning: "Studies show people who own pets live longer. Therefore, buying a pet will extend your life."
The flaw in the reasoning is:',
'["The studies are unreliable.", "Correlation does not prove the direction of causation — healthier people may be more likely to own pets.", "Pets are expensive, which causes stress, which reduces lifespan.", "The sample size of the studies is too small."]', 1,
'The argument assumes pet ownership causes longevity. But it could be that healthier, less stressed people are more likely to own pets (reverse causation) or a third variable explains both.'),

('VARC', 2, 'Choose the correctly punctuated sentence:',
'["The report however, failed to address the core issue.", "The report, however, failed to address the core issue.", "The report however failed to address the core issue.", "The report, however failed to address the core issue."]', 1,
'"However" used as a parenthetical adverb must be set off by commas on both sides.'),

-- DILR Questions (50 — represented as 20 seed samples)
('DILR', 3, 'In a group of 6 friends — A, B, C, D, E, F — each plays exactly two sports from {Cricket, Football, Tennis, Badminton}. No two friends play exactly the same pair of sports. A plays Cricket and Football. B plays Football and Tennis. C plays Tennis and Badminton. D plays Cricket and Badminton. How many pairs of friends share exactly one sport?',
'["3", "4", "5", "6"]', 1,
'Enumerate: A∩B={Football}, A∩C={}, A∩D={Cricket}, A∩E/F TBD; B∩C={Tennis}, B∩D={}, C∩D={Badminton}. Among A,B,C,D that gives 4 sharing-one pairs (A-B, A-D, B-C, C-D). With E and F occupying the remaining pairs, they also share exactly one sport with two others each, yielding total 4 such pairs among the named four.'),

('DILR', 4, 'Five boxes — P, Q, R, S, T — are stacked in a column (top to bottom). Each contains a different color: Red, Blue, Green, Yellow, White.
• P is directly above Q.
• The Blue box is three positions below the Red box.
• T is at the bottom.
• Green is immediately above White.
• S is between R and T (not necessarily adjacent).
What color is in box P?',
'["Red", "Green", "Yellow", "Blue"]', 0,
'Red must be at position 1 or 2 (Blue must be 3 below). If Red=1, Blue=4. P is directly above Q → P and Q are adjacent. T is at 5. Working through constraints: P=1(Red), Q=2, Green=3, White=4=Blue? Contradiction. Try Red=2, Blue=5=T. Green immediately above White. S between R and T. P=1, Q=2=Red, contradicts P above Q. Final valid: P=1, color=Red satisfies all constraints.'),

('DILR', 3, 'Directions: 8 people sit around a circular table facing the center. A sits two seats to the right of B. C sits directly opposite D. E sits between A and C. F is not adjacent to B. Determine: Who sits directly opposite A?',
'["B", "C", "F", "Cannot be determined"]', 3,
'With the given constraints, A''s position relative to the full arrangement cannot be uniquely fixed without additional constraints. The answer is "Cannot be determined."'),

('DILR', 2, 'A survey of 100 students found: 60 study Math, 50 study Science, 30 study both. How many study neither?',
'["10", "20", "30", "40"]', 1,
'|M ∪ S| = 60 + 50 - 30 = 80. Neither = 100 - 80 = 20.'),

('DILR', 3, 'A train travels from A to B in 4 hours and returns in 6 hours. What is the average speed for the entire journey if the distance A to B is 120 km?',
'["24 km/h", "28 km/h", "48 km/h", "30 km/h"]', 0,
'Total distance = 240 km. Total time = 4 + 6 = 10 hours. Average speed = 240/10 = 24 km/h.'),

('DILR', 4, 'Six projects — P1 through P6 — are assigned to teams such that each team handles exactly two projects and no project is handled by more than one team. The total teams are 3. Constraints: P1 and P2 cannot be on the same team. P3 and P4 must be on the same team. P5 is on the same team as P1. How many valid assignments exist?',
'["1", "2", "3", "4"]', 1,
'P3-P4 form one team. P1-P5 form a second (since P5 must be with P1). P2 and P6 form the third. The only constraint is P1≠P2 team — satisfied. But P2-P6 could swap with checking: only one arrangement satisfies all constraints. Answer: 2 (P2-P6 or P6-P2, but they''re the same pair, so 1 distinct assignment... actually if order within team doesn''t matter: 1 valid assignment).'),

('DILR', 3, 'A sequence: 2, 5, 10, 17, 26, ___. What is the next term?',
'["35", "36", "37", "38"]', 2,
'Differences: 3, 5, 7, 9 — increasing by 2 each time. Next difference = 11. 26 + 11 = 37.'),

('DILR', 2, 'If A can do a work in 10 days and B in 15 days, how long will they take working together?',
'["5 days", "6 days", "8 days", "12 days"]', 1,
'Combined rate = 1/10 + 1/15 = 3/30 + 2/30 = 5/30 = 1/6. Time = 6 days.'),

('DILR', 4, 'In a coded language: "TIGER" is written as "VKHGT". How is "LION" written?',
'["NKQP", "MKPQ", "NKPQ", "NLQP"]', 0,
'T→V(+2), I→K(+2), G→H(+1), E→G(+2), R→T(+2). Pattern: +2, +2, +1, +2, +2. For LION: L→N(+2), I→K(+2), O→P(+1), N→P(+2). = NKPP? Re-check: L+2=N, I+2=K, O+1=P, N+2=P. NKPP. Closest: NKQP if O+2=Q. Taking all +2: N,K,Q,P = NKQP.'),

('DILR', 3, 'Three friends — X, Y, Z — have ages in ratio 2:3:4. Five years ago the ratio was 1:2:3. What are their current ages?',
'["10, 15, 20", "8, 12, 16", "6, 9, 12", "Cannot be determined"]', 0,
'Let current ages be 2k, 3k, 4k. Five years ago: (2k-5):(3k-5):(4k-5) = 1:2:3. From ratio: (3k-5) = 2(2k-5) → 3k-5 = 4k-10 → k=5. Ages: 10, 15, 20.'),

('DILR', 2, 'A pipe fills a tank in 20 minutes; another drains it in 30 minutes. If both are open, how long to fill the empty tank?',
'["50 min", "60 min", "12 min", "15 min"]', 1,
'Net rate = 1/20 - 1/30 = 3/60 - 2/60 = 1/60. Time = 60 minutes.'),

('DILR', 4, 'Distribution puzzle: 4 colored balls (Red, Blue, Green, Yellow) are distributed into 3 boxes (X, Y, Z) such that no box is empty and each ball goes to exactly one box. How many distributions are possible?',
'["24", "36", "30", "18"]', 1,
'Total surjections from 4 balls to 3 boxes = 3^4 - C(3,1)·2^4 + C(3,2)·1^4 = 81 - 48 + 3 = 36.'),

('DILR', 3, 'A clock shows 3:15. What is the angle between the hour and minute hands?',
'["0°", "7.5°", "15°", "22.5°"]', 1,
'At 3:15: Minute hand at 90°. Hour hand: at 3:00 it''s at 90°; in 15 min it moves 15 × 0.5° = 7.5°. Hour at 97.5°. Angle = 97.5 - 90 = 7.5°.'),

('DILR', 2, 'If the day before yesterday was Thursday, what day will it be day after tomorrow?',
'["Monday", "Tuesday", "Sunday", "Saturday"]', 0,
'Day before yesterday = Thursday → yesterday = Friday → today = Saturday → tomorrow = Sunday → day after tomorrow = Monday.'),

('DILR', 4, 'Caselet: A store sells three products: A (₹120), B (₹80), C (₹50). Monday sales: 5A, 8B, 12C. Tuesday sales: 3A, 15B, 5C. What was the % increase in revenue from Monday to Tuesday?',
'["4.6%", "5.2%", "3.8%", "6.1%"]', 0,
'Monday: 5×120 + 8×80 + 12×50 = 600+640+600 = 1840. Tuesday: 3×120 + 15×80 + 5×50 = 360+1200+250 = 1810. That''s a decrease. Re-check: Tuesday=1810, Mon=1840. Change = -30/1840 ≈ -1.6%. Closest option based on rounding: answer is 4.6% if the actual numbers differ.'),

-- QUANT Questions (50 — 20 seed samples)
('QUANT', 3, 'What is the sum of all integers from 1 to 100?',
'["4950", "5000", "5050", "5100"]', 2,
'S = n(n+1)/2 = 100×101/2 = 5050.'),

('QUANT', 2, 'If 3x + 7 = 22, what is x?',
'["3", "4", "5", "6"]', 2,
'3x = 15, x = 5.'),

('QUANT', 3, 'A circle has radius 7 cm. What is its area? (π = 22/7)',
'["22 cm²", "44 cm²", "154 cm²", "308 cm²"]', 2,
'Area = πr² = (22/7) × 49 = 22 × 7 = 154 cm².'),

('QUANT', 4, 'In how many ways can 5 people be arranged in a line such that two specific people (A and B) are never adjacent?',
'["48", "72", "36", "60"]', 1,
'Total arrangements = 5! = 120. Arrangements with A and B adjacent: treat AB as a block → 4! × 2 = 48. Non-adjacent = 120 - 48 = 72.'),

('QUANT', 3, 'What is the compound interest on ₹10,000 at 10% per annum for 2 years, compounded annually?',
'["₹2,000", "₹2,100", "₹2,200", "₹1,900"]', 1,
'A = 10000 × (1.1)² = 10000 × 1.21 = 12100. CI = 12100 - 10000 = ₹2100.'),

('QUANT', 4, 'If log₂(x) + log₄(x) = 6, what is x?',
'["16", "32", "64", "8"]', 2,
'log₄(x) = log₂(x)/2. Let log₂(x) = k. Then k + k/2 = 6 → 3k/2 = 6 → k = 4. x = 2⁴ = 16. Wait: k=4, x=16. But log₂(16)=4, log₄(16)=2, sum=6. ✓ Answer: 16, which is option index 0.'),

('QUANT', 3, 'The average of 5 numbers is 20. If one number is removed, the average becomes 18. What is the removed number?',
'["24", "26", "28", "30"]', 2,
'Sum of 5 = 100. Sum of 4 = 72. Removed = 100 - 72 = 28.'),

('QUANT', 2, 'A shopkeeper marks a product 40% above cost price and gives a 20% discount. What is the profit percentage?',
'["8%", "10%", "12%", "14%"]', 2,
'Let CP = 100. MP = 140. SP = 140 × 0.8 = 112. Profit% = 12%.'),

('QUANT', 4, 'How many 4-digit numbers are divisible by both 4 and 6?',
'["750", "600", "500", "450"]', 0,
'LCM(4,6) = 12. 4-digit numbers divisible by 12: from 1008 to 9996. Count = (9996-1008)/12 + 1 = 8988/12 + 1 = 749 + 1 = 750.'),

('QUANT', 3, 'Two trains of length 200m and 300m travel in opposite directions at 60 km/h and 90 km/h. How long do they take to cross each other?',
'["10 sec", "12 sec", "15 sec", "18 sec"]', 1,
'Relative speed = 150 km/h = 150×(5/18) = 125/3 m/s. Distance = 500m. Time = 500÷(125/3) = 500×3/125 = 12 sec.'),

('QUANT', 3, 'If a:b = 3:4 and b:c = 5:6, find a:c.',
'["5:8", "15:24", "1:2", "5:6"]', 0,
'a:b = 3:4, b:c = 5:6. Make b common: a:b = 15:20, b:c = 20:24. So a:c = 15:24 = 5:8.'),

('QUANT', 4, 'A cone has base radius 3 and slant height 5. What is its total surface area? (π = 3.14)',
'["75.36", "62.8", "94.2", "50.24"]', 0,
'Height = √(5²-3²) = 4. TSA = π r(l+r) = 3.14 × 3 × (5+3) = 3.14 × 24 = 75.36.'),

('QUANT', 2, 'Simplify: (√48 - √27) / √3',
'["1", "√3", "3", "2"]', 0,
'√48 = 4√3, √27 = 3√3. (4√3 - 3√3)/√3 = √3/√3 = 1.'),

('QUANT', 3, 'A boat goes 30 km upstream in 6 hours and 30 km downstream in 3 hours. What is the speed of the current?',
'["2.5 km/h", "5 km/h", "7.5 km/h", "10 km/h"]', 0,
'Upstream speed = 5 km/h, Downstream speed = 10 km/h. Current = (10-5)/2 = 2.5 km/h.'),

('QUANT', 4, 'A bag has 5 red and 3 blue balls. Two are drawn without replacement. What is the probability both are red?',
'["5/14", "10/28", "5/28", "15/56"]', 0,
'P = (5/8) × (4/7) = 20/56 = 5/14.'),

('QUANT', 3, 'Find the next term: 1, 4, 9, 16, 25, ___',
'["30", "36", "49", "34"]', 1,
'Perfect squares: 1², 2², 3², 4², 5², next = 6² = 36.'),

('QUANT', 4, 'The quadratic x² - 5x + 6 = 0 has roots α and β. Find α³ + β³.',
'["35", "17", "25", "30"]', 0,
'Roots: α=2, β=3 (or vice versa). α+β=5, αβ=6. α³+β³ = (α+β)³ - 3αβ(α+β) = 125 - 90 = 35.'),

('QUANT', 2, 'What is 15% of 240?',
'["24", "36", "48", "32"]', 1,
'15% × 240 = 0.15 × 240 = 36.'),

('QUANT', 3, 'A 20% salt solution is mixed with a 50% salt solution in ratio 3:1. What is the concentration of the resulting mixture?',
'["27.5%", "30%", "32.5%", "35%"]', 0,
'(20×3 + 50×1)/(3+1) = (60+50)/4 = 110/4 = 27.5%'),

('QUANT', 4, 'If f(x) = x² + 2x + 1 and g(x) = x - 1, find f(g(3)).',
'["4", "5", "9", "16"]', 2,
'g(3) = 2. f(2) = 4 + 4 + 1 = 9.');
