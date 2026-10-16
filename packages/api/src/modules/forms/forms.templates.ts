/** Starter templates shared by the create endpoint and the template gallery. */
import type { FormDefinitionDto } from "./forms.types";

export type FormTemplateCategory =
	| "Events"
	| "Feedback"
	| "Business"
	| "Marketing";

export type FormTemplate = {
	id: string;
	name: string;
	summary: string;
	category: FormTemplateCategory | "Start";
	draft: FormDefinitionDto;
};

export const formTemplateCategories: FormTemplateCategory[] = [
	"Events",
	"Feedback",
	"Business",
	"Marketing",
];

export const formTemplates: FormTemplate[] = [
	{
		id: "registration",
		name: "Registration",
		summary: "Collect names, email addresses and session choices.",
		category: "Events",
		draft: {
			title: "Workshop registration",
			description: "Share a few details to reserve your place.",
			accent: "blue",
			confirmationMessage: "You're registered. See you there!",
			fields: [
				{ id: "name", type: "short", label: "Full name", required: true },
				{ id: "email", type: "email", label: "Email", required: true },
				{ id: "phone", type: "phone", label: "Phone", required: false },
				{
					id: "session",
					type: "singlechoice",
					label: "Which session?",
					required: false,
					options: ["Morning", "Afternoon"],
				},
			],
		},
	},
	{
		id: "contact",
		name: "Contact",
		summary: "Give people a straightforward way to reach you.",
		category: "Business",
		draft: {
			title: "Get in touch",
			description: "We usually reply within two working days.",
			accent: "teal",
			confirmationMessage: "Thanks for reaching out. We'll reply soon.",
			fields: [
				{ id: "name", type: "short", label: "Your name", required: true },
				{ id: "email", type: "email", label: "Email", required: true },
				{
					id: "topic",
					type: "singlechoice",
					label: "What is it about?",
					required: false,
					options: ["A question", "Working together", "Something else"],
				},
				{ id: "message", type: "paragraph", label: "Message", required: true },
			],
		},
	},
	{
		id: "feedback",
		name: "Feedback",
		summary: "Gather ratings, comments and suggestions.",
		category: "Feedback",
		draft: {
			title: "How was your experience?",
			description: "A few quick questions to help us improve.",
			accent: "orange",
			confirmationMessage: "Your feedback helps us get better.",
			fields: [
				{
					id: "rating",
					type: "rating",
					label: "How would you rate it overall?",
					required: true,
				},
				{
					id: "highlights",
					type: "multichoice",
					label: "What stood out?",
					required: false,
					options: ["Content", "People", "Venue", "Organization"],
				},
				{
					id: "improve",
					type: "paragraph",
					label: "What could we improve?",
					required: false,
				},
			],
		},
	},
	{
		id: "rsvp",
		name: "Event RSVP",
		summary: "Confirm who is coming and plan for guests and diets.",
		category: "Events",
		draft: {
			title: "Will you join us?",
			description: "Let us know by Friday so we can plan food and seating.",
			accent: "pink",
			confirmationMessage: "Thanks for letting us know!",
			fields: [
				{ id: "name", type: "short", label: "Your name", required: true },
				{ id: "email", type: "email", label: "Email", required: true },
				{
					id: "attending",
					type: "singlechoice",
					label: "Can you make it?",
					required: true,
					options: ["Yes, I will be there", "Maybe", "Sorry, I cannot"],
				},
				{
					id: "guests",
					type: "number",
					label: "Number of guests",
					required: false,
				},
				{
					id: "dietary",
					type: "short",
					label: "Dietary requirements",
					required: false,
				},
			],
		},
	},
	{
		id: "satisfaction",
		name: "Customer satisfaction",
		summary: "Measure how happy customers are and why.",
		category: "Feedback",
		draft: {
			title: "How did we do?",
			description: "Two minutes of your time helps us serve you better.",
			accent: "green",
			confirmationMessage: "We read every answer and use it to improve.",
			fields: [
				{
					id: "satisfaction",
					type: "rating",
					label: "How satisfied are you overall?",
					required: true,
				},
				{
					id: "recommend",
					type: "singlechoice",
					label: "How likely are you to recommend us?",
					required: false,
					options: ["Very likely", "Likely", "Not sure", "Unlikely"],
				},
				{
					id: "reason",
					type: "paragraph",
					label: "What is the main reason for your score?",
					required: false,
				},
			],
		},
	},
	{
		id: "job",
		name: "Job application",
		summary: "Screen candidates with the essentials up front.",
		category: "Business",
		draft: {
			title: "Apply to join the team",
			description:
				"Tell us a little about yourself. We reply to every application.",
			accent: "graphite",
			confirmationMessage: "Application received. We will be in touch soon.",
			fields: [
				{ id: "name", type: "short", label: "Full name", required: true },
				{ id: "email", type: "email", label: "Email", required: true },
				{
					id: "role",
					type: "singlechoice",
					label: "Which role are you applying for?",
					required: true,
					options: ["Design", "Engineering", "Marketing", "Operations"],
				},
				{
					id: "portfolio",
					type: "short",
					label: "Portfolio or LinkedIn URL",
					required: false,
				},
				{
					id: "motivation",
					type: "paragraph",
					label: "Why do you want to join us?",
					required: false,
				},
			],
		},
	},
	{
		id: "order",
		name: "Order request",
		summary: "Take simple orders without a full online shop.",
		category: "Business",
		draft: {
			title: "Place an order",
			description:
				"Pick what you would like and we will confirm the total by email.",
			accent: "orange",
			confirmationMessage: "Order received. We will email you to confirm.",
			fields: [
				{ id: "name", type: "short", label: "Your name", required: true },
				{ id: "email", type: "email", label: "Email", required: true },
				{
					id: "items",
					type: "multichoice",
					label: "What would you like?",
					required: true,
					options: ["T-shirt", "Hoodie", "Tote bag", "Stickers"],
				},
				{ id: "quantity", type: "number", label: "Quantity", required: false },
				{
					id: "delivery",
					type: "date",
					label: "Preferred delivery date",
					required: false,
				},
			],
		},
	},
	{
		id: "booking",
		name: "Appointment booking",
		summary: "Let clients request a day and time that suits them.",
		category: "Business",
		draft: {
			title: "Book an appointment",
			description: "Choose a day and time and we will confirm within 24 hours.",
			accent: "blue",
			confirmationMessage:
				"Request received. We will confirm your slot shortly.",
			fields: [
				{ id: "name", type: "short", label: "Your name", required: true },
				{ id: "phone", type: "phone", label: "Phone", required: true },
				{ id: "day", type: "date", label: "Preferred date", required: true },
				{
					id: "time",
					type: "singlechoice",
					label: "Preferred time",
					required: false,
					options: ["Morning", "Afternoon", "Evening"],
				},
				{
					id: "notes",
					type: "paragraph",
					label: "Anything we should prepare?",
					required: false,
				},
			],
		},
	},
	{
		id: "newsletter",
		name: "Newsletter signup",
		summary: "Grow your list and learn what readers want.",
		category: "Marketing",
		draft: {
			title: "Get the newsletter",
			description: "One short email a month. Unsubscribe any time.",
			accent: "teal",
			confirmationMessage: "You are subscribed. Welcome aboard!",
			fields: [
				{ id: "email", type: "email", label: "Email", required: true },
				{
					id: "first_name",
					type: "short",
					label: "First name",
					required: false,
				},
				{
					id: "topics",
					type: "multichoice",
					label: "What would you like to hear about?",
					required: false,
					options: ["Product updates", "Tips and guides", "Events", "Offers"],
				},
			],
		},
	},
	{
		id: "waitlist",
		name: "Waitlist",
		summary: "Collect early interest before you launch.",
		category: "Marketing",
		draft: {
			title: "Join the waitlist",
			description: "Be the first to know when we open the doors.",
			accent: "graphite",
			confirmationMessage: "You are on the list. We will email you first.",
			fields: [
				{ id: "email", type: "email", label: "Email", required: true },
				{ id: "name", type: "short", label: "Name", required: false },
				{
					id: "source",
					type: "singlechoice",
					label: "How did you hear about us?",
					required: false,
					options: ["Friend or colleague", "Social media", "Search", "Other"],
				},
				{
					id: "use_case",
					type: "paragraph",
					label: "What would you use it for?",
					required: false,
				},
			],
		},
	},
	{
		id: "blank",
		name: "Blank form",
		summary: "Start fresh with the questions you need.",
		category: "Start",
		draft: {
			title: "Untitled form",
			description: "",
			accent: "blue",
			confirmationMessage: "Your response has been recorded.",
			fields: [],
		},
	},
];

export function formTemplateDraft(
	template: string,
	title?: string,
): FormDefinitionDto {
	const source =
		formTemplates.find((item) => item.id === template) ??
		(formTemplates.find((item) => item.id === "blank") as FormTemplate);
	const draft = structuredClone(source.draft);
	if (title?.trim()) draft.title = title.trim();
	return draft;
}
